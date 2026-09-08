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
  fmtDateTime,
  type Col,
} from "../_shared";
import {
  validateFleetTruckInput,
  type FieldError,
} from "@/lib/fleet/validate";

export type FleetTruck = {
  id: string;
  truck_number: string;
  plate: string | null;
  updated_at: string;
};

// Search: nº or plate, partial and case-insensitive.
function matchesSearch(t: FleetTruck, needle: string): boolean {
  if (!needle) return true;
  return [t.truck_number, t.plate].some(
    (v) => v != null && v.toLowerCase().includes(needle),
  );
}

const columns: Col<FleetTruck>[] = [
  { key: "truck_number", label: "Nº Camião", value: (r) => r.truck_number },
  {
    key: "plate",
    label: "Matrícula",
    value: (r) => r.plate ?? "",
    render: (r) =>
      r.plate ? (
        <span className="font-mono">{r.plate}</span>
      ) : (
        <span className="text-black/40 dark:text-white/40">—</span>
      ),
  },
  {
    key: "updated_at",
    label: "Atualizado",
    value: (r) => new Date(r.updated_at).getTime(),
    render: (r) => fmtDateTime(r.updated_at),
  },
];

// ---------------------------------------------------------------------------
// Edit / create panel
// ---------------------------------------------------------------------------

type FormState = { truck_number: string; plate: string };

function toForm(t: FleetTruck | null): FormState {
  return { truck_number: t?.truck_number ?? "", plate: t?.plate ?? "" };
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

type PanelMode = { kind: "edit"; truck: FleetTruck } | { kind: "create" };

function TruckPanel({
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
    toForm(mode.kind === "edit" ? mode.truck : null),
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
    (k: keyof FormState) => (e: ChangeEvent<HTMLInputElement>) =>
      setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);

    const parsed = validateFleetTruckInput(form);
    if (!parsed.ok) {
      setErrors(fieldErrorsToMap(parsed.errors));
      return;
    }
    setErrors({});
    setSaving(true);
    try {
      const res = await fetch(
        isEdit ? `/api/fleet-trucks/${mode.truck.id}` : "/api/fleet-trucks",
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
        aria-label={isEdit ? "Editar camião" : "Adicionar camião"}
        className="flex h-full w-full max-w-md flex-col overflow-y-auto border-l border-black/10 bg-[var(--background)] shadow-xl dark:border-white/15"
      >
        <div className="flex items-center justify-between border-b border-black/10 px-6 py-4 dark:border-white/15">
          <h2 className="text-lg font-medium">
            {isEdit ? "Editar camião" : "Adicionar camião"}
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

          <Field label="Nº Camião *" error={errors.truck_number}>
            <input
              className={inputClass}
              value={form.truck_number}
              onChange={set("truck_number")}
              required
              autoFocus
            />
          </Field>

          <Field
            label="Matrícula"
            error={errors.plate}
            hint="Com ou sem hífens — normalizada ao comparar."
          >
            <input
              className={`${inputClass} font-mono`}
              value={form.plate}
              onChange={set("plate")}
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
              Atualizado em{" "}
              {new Date(mode.truck.updated_at).toLocaleString("pt-PT")}
            </p>
          )}
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function CamioesClient({
  trucks,
  loadError,
}: {
  trucks: FleetTruck[];
  loadError: string | null;
}) {
  const router = useRouter();
  const search = useDebouncedSearch();
  const [panel, setPanel] = useState<PanelMode | null>(null);

  const filtered = useMemo(
    () => trucks.filter((t) => matchesSearch(t, search.value)),
    [trucks, search.value],
  );

  const missingPlate = useMemo(
    () => trucks.filter((t) => !t.plate).length,
    [trucks],
  );

  return (
    <main className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Camiões</h1>
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
            Adicionar novo
          </button>
        </div>
      </header>

      <div className="mb-6">
        <Notice>
          Referência auxiliar «nº do camião → matrícula». Preenchida à mão e{" "}
          <strong>pode estar desatualizada</strong> — a folha TFS só a usa como
          pista quando a linha não traz matrícula.
        </Notice>
      </div>

      {loadError && (
        <div className="mb-6">
          <Notice>
            Erro a carregar camiões:{" "}
            <code className="font-mono">{loadError}</code>
            {" — "}confirma que a migração{" "}
            <code className="font-mono">0025_fleet_trucks.sql</code> foi
            aplicada.
          </Notice>
        </div>
      )}

      <section>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-medium">
            Todos os camiões{" "}
            <span className="text-sm font-normal text-black/40 dark:text-white/40">
              ({filtered.length}
              {search.value ? ` · “${search.value}”` : ""}
              {missingPlate > 0 ? ` · ${missingPlate} sem matrícula` : ""})
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
              placeholder="nº ou matrícula…"
              className="w-56 rounded-md border border-black/15 bg-white/75 px-2 py-1 backdrop-blur-xs dark:border-white/20 dark:bg-neutral-900/75"
            />
          </label>
        </div>

        {!loadError && (
          <SortableTable
            rows={filtered}
            columns={columns}
            initialSort={{ key: "truck_number", dir: "asc" }}
            onRowClick={(t) => setPanel({ kind: "edit", truck: t })}
          />
        )}
      </section>

      {panel && (
        <TruckPanel
          key={panel.kind === "edit" ? panel.truck.id : "create"}
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
