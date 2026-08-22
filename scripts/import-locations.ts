import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "csv-parse/sync";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

config({ path: resolve(process.cwd(), ".env.local") });

const VALID_TYPES = new Set([
  "loja",
  "armazem",
  "centro_distribuicao",
  "fornecedor",
  "oficina",
]);

const BATCH_SIZE = 500;

type CsvRow = {
  code: string;
  arp2_code?: string;
  name?: string;
  type?: string;
  address?: string;
  locality?: string;
  latitude?: string;
  longitude?: string;
};

type LocationRow = {
  code: string;
  arp2_code: string | null;
  name: string | null;
  type: string | null;
  address: string | null;
  locality: string | null;
  latitude: number | null;
  longitude: number | null;
  updated_at: string;
};

function main() {
  const csvPath = resolve(process.cwd(), process.argv[2] ?? "data/locations_import.csv");

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured");
  }

  const raw = readFileSync(csvPath, "utf-8");
  const rows: CsvRow[] = parse(raw, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
  });

  const valid: LocationRow[] = [];
  const skipped: Array<{ row: number; code?: string; reason: string }> = [];
  const now = new Date().toISOString();

  rows.forEach((row, index) => {
    const rowNumber = index + 2; // +1 for header, +1 for 1-based

    if (!row.code) {
      skipped.push({ row: rowNumber, reason: "missing code" });
      return;
    }

    if (row.type && !VALID_TYPES.has(row.type)) {
      skipped.push({
        row: rowNumber,
        code: row.code,
        reason: `invalid type "${row.type}"`,
      });
      return;
    }

    const latitude = row.latitude ? Number(row.latitude) : null;
    const longitude = row.longitude ? Number(row.longitude) : null;
    if (row.latitude && Number.isNaN(latitude)) {
      skipped.push({ row: rowNumber, code: row.code, reason: "invalid latitude" });
      return;
    }
    if (row.longitude && Number.isNaN(longitude)) {
      skipped.push({ row: rowNumber, code: row.code, reason: "invalid longitude" });
      return;
    }

    valid.push({
      code: row.code,
      arp2_code: row.arp2_code || null,
      name: row.name || null,
      type: row.type || null,
      address: row.address || null,
      locality: row.locality || null,
      latitude,
      longitude,
      updated_at: now,
    });
  });

  if (skipped.length > 0) {
    console.warn(`Skipped ${skipped.length} row(s):`);
    for (const s of skipped) {
      console.warn(`  row ${s.row}${s.code ? ` (${s.code})` : ""}: ${s.reason}`);
    }
  }

  if (valid.length === 0) {
    console.log("Nothing to import.");
    return;
  }

  const supabase = createClient(supabaseUrl, serviceKey);
  importBatches(valid).catch((err) => {
    console.error(err);
    process.exit(1);
  });

  async function importBatches(rows: LocationRow[]) {
    let imported = 0;
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      const { error } = await supabase.from("locations").upsert(batch, { onConflict: "code" });
      if (error) {
        throw new Error(`Batch starting at row ${i} failed: ${error.message}`);
      }
      imported += batch.length;
      console.log(`Imported ${imported}/${rows.length}`);
    }
    console.log(`Done. ${imported} location(s) upserted.`);
  }
}

main();
