"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useEffect,
  useMemo,
  useState,
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  SortableTable,
  useDebouncedSearch,
  Notice,
  chipClass,
  type Col,
} from "../_shared";
import {
  LOCATION_TYPES,
  PT_LAT,
  PT_LNG,
  validateLocationInput,
  type FieldError,
  type LocationType,
} from "@/lib/locations/validate";

export type Location = {
  id: string;
  code: string;
  arp2_code: string | null;
  name: string | null;
  type: string | null;
  address: string | null;
  locality: string | null;
  latitude: number | null;
  longitude: number | null;
  radius_meters: number;
  updated_at: string;
};

const TYPE_LABELS: Record<LocationType, string> = {
  loja: "Loja",
  armazem: "Armazém",
  centro_distribuicao: "Centro de distribuição",
  fornecedor: "Fornecedor",
  oficina: "Oficina",
};

function typeLabel(t: string | null): string {
  if (!t) return "—";
  return TYPE_LABELS[t as LocationType] ?? t;
}

function fmtCoord(n: number | null): string {
  return n == null ? "—" : n.toFixed(5);
}

// Search: name or code, partial and case-insensitive (see the request).
function matchesSearch(l: Location, needle: string): boolean {
  if (!needle) return true;
  return [l.name, l.code].some(
    (v) => v != null && v.toLowerCase().includes(needle),
  );
}

const columns: Col<Location>[] = [
  { key: "code", label: "Código", value: (r) => r.code },
  {
    key: "name",
    label: "Nome",
    value: (r) => r.name ?? "",
    render: (r) => r.name ?? "—",
  },
  {
    key: "type",
    label: "Tipo",
    value: (r) => r.type ?? "",
    render: (r) => typeLabel(r.type),
  },
  {
    key: "address",
    label: "Morada",
    value: (r) => r.address ?? "",
    render: (r) =>
      r.address ? (
        <span className="block max-w-[240px] truncate" title={r.address}>
          {r.address}
        </span>
      ) : (
        "—"
      ),
  },
  {
    key: "locality",
    label: "Localidade",
    value: (r) => r.locality ?? "",
    render: (r) => r.locality ?? "—",
  },
  {
    key: "lat",
    label: "Lat",
    align: "right",
    value: (r) => r.latitude,
    render: (r) => fmtCoord(r.latitude),
  },
  {
    key: "lng",
    label: "Lng",
    align: "right",
    value: (r) => r.longitude,
    render: (r) => fmtCoord(r.longitude),
  },
  {
    key: "radius",
    label: "Raio (m)",
    align: "right",
    value: (r) => r.radius_meters,
  },
];

// ---------------------------------------------------------------------------
// Edit / create panel
// ---------------------------------------------------------------------------

type FormState = {
  code: string;
  arp2_code: string;
  name: string;
  type: string;
  address: string;
  locality: string;
  latitude: string;
  longitude: string;
  radius_meters: string;
};

function toForm(l: Location | null): FormState {
  return {
    code: l?.code ?? "",
    arp2_code: l?.arp2_code ?? "",
    name: l?.name ?? "",
    type: l?.type ?? "",
    address: l?.address ?? "",
    locality: l?.locality ?? "",
    latitude: l?.latitude != null ? String(l.latitude) : "",
    longitude: l?.longitude != null ? String(l.longitude) : "",
    radius_meters: l?.radius_meters != null ? String(l.radius_meters) : "150",
  };
}

function fieldErrorsToMap(errs: FieldError[]): Record<string, string> {
  const m: Record<string, string> = {};
  for (const e of errs) if (!m[e.field]) m[e.field] = e.message;
  return m;
}

const inputClass =
  "rounded-md border border-black/15 bg-transparent px-2 py-1.5 text-sm outline-none focus:border-black/40 dark:border-white/20 dark:focus:border-white/50";

function Field({
  label,
  error,
  hint,
  children,
}: {
  label: string;
  error?: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-medium">{label}</span>
      {children}
      {hint && (
        <span className="text-xs text-black/40 dark:text-white/40">{hint}</span>
      )}
      {error && (
        <span className="text-xs text-red-600 dark:text-red-400">{error}</span>
      )}
    </label>
  );
}

type PanelMode = { kind: "edit"; location: Location } | { kind: "create" };

function LocationPanel({
  mode,
  onClose,
  onSaved,
}: {
  mode: PanelMode;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = mode.kind === "edit";
  const [form, setForm] = useState<FormState>(() =>
    toForm(mode.kind === "edit" ? mode.location : null),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const set =
    (k: keyof FormState) =>
    (
      e: ChangeEvent<
        HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
      >,
    ) =>
      setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);

    // Mirror the server-side rules so obvious mistakes never round-trip.
    const parsed = validateLocationInput(form);
    if (!parsed.ok) {
      setErrors(fieldErrorsToMap(parsed.errors));
      return;
    }
    setErrors({});
    setSaving(true);
    try {
      const res = await fetch(
        isEdit ? `/api/locations/${mode.location.id}` : "/api/locations",
        {
          method: isEdit ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(parsed.value),
        },
      );
      const json: { error?: string; errors?: FieldError[] } = await res
        .json()
        .catch(() => ({}));
      if (!res.ok) {
        if (Array.isArray(json.errors)) setErrors(fieldErrorsToMap(json.errors));
        setFormError(json.error ?? `Erro ${res.status}.`);
        return;
      }
      onSaved();
    } catch {
      setFormError("Falha de rede. Tenta novamente.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex">
      <div
        className="flex-1 bg-black/30 dark:bg-black/50"
        onClick={onClose}
        aria-hidden
      />
      <div
        role="dialog"
        aria-modal
        aria-label={isEdit ? "Editar location" : "Adicionar location"}
        className="flex h-full w-full max-w-md flex-col overflow-y-auto border-l border-black/10 bg-[var(--background)] shadow-xl dark:border-white/15"
      >
        <div className="flex items-center justify-between border-b border-black/10 px-6 py-4 dark:border-white/15">
          <h2 className="text-lg font-medium">
            {isEdit ? "Editar location" : "Adicionar location"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-sm text-black/50 hover:bg-black/[.05] dark:text-white/50 dark:hover:bg-white/[.06]"
          >
            Fechar ✕
          </button>
        </div>

        <form onSubmit={submit} className="flex flex-col gap-4 px-6 py-5">
          {formError && (
            <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300">
              {formError}
            </div>
          )}

          <Field label="Código *" error={errors.code}>
            <input
              className={inputClass}
              value={form.code}
              onChange={set("code")}
              required
            />
          </Field>

          <Field label="Código ARP2" error={errors.arp2_code}>
            <input
              className={inputClass}
              value={form.arp2_code}
              onChange={set("arp2_code")}
            />
          </Field>

          <Field label="Nome" error={errors.name}>
            <input
              className={inputClass}
              value={form.name}
              onChange={set("name")}
            />
          </Field>

          <Field label="Tipo" error={errors.type}>
            <select
              className={inputClass}
              value={form.type}
              onChange={set("type")}
            >
              <option value="">(sem tipo)</option>
              {LOCATION_TYPES.map((t) => (
                <option key={t} value={t}>
                  {TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Morada" error={errors.address}>
            <textarea
              className={`${inputClass} min-h-[64px] resize-y`}
              value={form.address}
              onChange={set("address")}
            />
          </Field>

          <Field label="Localidade" error={errors.locality}>
            <input
              className={inputClass}
              value={form.locality}
              onChange={set("locality")}
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field
              label="Latitude"
              error={errors.latitude}
              hint={`${PT_LAT.min} a ${PT_LAT.max}`}
            >
              <input
                className={inputClass}
                type="number"
                step="any"
                inputMode="decimal"
                value={form.latitude}
                onChange={set("latitude")}
              />
            </Field>
            <Field
              label="Longitude"
              error={errors.longitude}
              hint={`${PT_LNG.min} a ${PT_LNG.max}`}
            >
              <input
                className={inputClass}
                type="number"
                step="any"
                inputMode="decimal"
                value={form.longitude}
                onChange={set("longitude")}
              />
            </Field>
          </div>

          <Field label="Raio (metros)" error={errors.radius_meters}>
            <input
              className={inputClass}
              type="number"
              step="1"
              value={form.radius_meters}
              onChange={set("radius_meters")}
            />
          </Field>

          <div className="mt-2 flex items-center gap-3">
            <button
              type="submit"
              disabled={saving}
              className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? "A gravar…" : isEdit ? "Guardar" : "Criar"}
            </button>
            <button
              type="button"
              onClick={onClose}
              className={chipClass}
              disabled={saving}
            >
              Cancelar
            </button>
          </div>

          {isEdit && (
            <p className="text-xs text-black/40 dark:text-white/40">
              Atualizada em{" "}
              {new Date(mode.location.updated_at).toLocaleString("pt-PT")}
            </p>
          )}
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function LocationsClient({
  locations,
  loadError,
}: {
  locations: Location[];
  loadError: string | null;
}) {
  const router = useRouter();
  const search = useDebouncedSearch();
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [panel, setPanel] = useState<PanelMode | null>(null);

  const filtered = useMemo(() => {
    return locations.filter((l) => {
      if (typeFilter === "none") {
        if (l.type) return false;
      } else if (typeFilter !== "all" && l.type !== typeFilter) {
        return false;
      }
      return matchesSearch(l, search.value);
    });
  }, [locations, typeFilter, search.value]);

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <header className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Locations</h1>
          <p className="mt-1 text-sm text-black/50 dark:text-white/50">
            Uso interno · sem autenticação
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link href="/dashboard" className={chipClass}>
            ← Dashboard
          </Link>
          <button
            type="button"
            onClick={() => setPanel({ kind: "create" })}
            className="rounded-md bg-foreground px-3 py-1.5 text-sm font-medium text-background transition-opacity hover:opacity-90"
          >
            Adicionar nova
          </button>
        </div>
      </header>

      {loadError && (
        <div className="mb-8">
          <Notice>
            Erro a carregar locations:{" "}
            <code className="font-mono">{loadError}</code>
          </Notice>
        </div>
      )}

      <section>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-medium">
            Todas as locations{" "}
            <span className="text-sm font-normal text-black/40 dark:text-white/40">
              ({filtered.length}
              {search.value ? ` · “${search.value}”` : ""}
              {typeFilter !== "all"
                ? ` · ${typeFilter === "none" ? "sem tipo" : typeLabel(typeFilter)}`
                : ""}
              )
            </span>
          </h2>
        </div>

        <div className="mb-3 flex flex-wrap items-end gap-x-6 gap-y-3 text-sm">
          <label className="flex flex-col gap-1">
            <span className="text-black/50 dark:text-white/50">Pesquisar</span>
            <input
              type="search"
              value={search.input}
              onChange={(e) => search.setInput(e.target.value)}
              placeholder="nome ou código…"
              className="w-56 rounded-md border border-black/15 bg-transparent px-2 py-1 dark:border-white/20"
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-black/50 dark:text-white/50">Tipo</span>
            <select
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
              className="rounded-md border border-black/15 bg-transparent px-2 py-1 dark:border-white/20"
            >
              <option value="all">Todos</option>
              {LOCATION_TYPES.map((t) => (
                <option key={t} value={t}>
                  {TYPE_LABELS[t]}
                </option>
              ))}
              <option value="none">(sem tipo)</option>
            </select>
          </label>
        </div>

        {!loadError && (
          <SortableTable
            rows={filtered}
            columns={columns}
            initialSort={{ key: "code", dir: "asc" }}
            onRowClick={(l) => setPanel({ kind: "edit", location: l })}
          />
        )}
      </section>

      {panel && (
        <LocationPanel
          key={panel.kind === "edit" ? panel.location.id : "create"}
          mode={panel}
          onClose={() => setPanel(null)}
          onSaved={() => {
            setPanel(null);
            router.refresh();
          }}
        />
      )}
    </main>
  );
}
