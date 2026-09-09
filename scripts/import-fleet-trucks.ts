import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "csv-parse/sync";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

config({ path: resolve(process.cwd(), ".env.local") });

const BATCH_SIZE = 500;

type CsvRow = {
  truck_number: string;
  plate?: string;
};

type TruckRow = {
  truck_number: string;
  plate: string | null;
  updated_at: string;
};

function main() {
  const csvPath = resolve(process.cwd(), process.argv[2] ?? "data/fleet_trucks_import.csv");

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

  const valid: TruckRow[] = [];
  const skipped: Array<{ row: number; truck_number?: string; reason: string }> = [];
  const now = new Date().toISOString();

  rows.forEach((row, index) => {
    const rowNumber = index + 2; // +1 for header, +1 for 1-based

    if (!row.truck_number) {
      skipped.push({ row: rowNumber, reason: "missing truck_number" });
      return;
    }

    valid.push({
      truck_number: row.truck_number,
      plate: row.plate || null,
      updated_at: now,
    });
  });

  if (skipped.length > 0) {
    console.warn(`Skipped ${skipped.length} row(s):`);
    for (const s of skipped) {
      console.warn(`  row ${s.row}${s.truck_number ? ` (${s.truck_number})` : ""}: ${s.reason}`);
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

  async function importBatches(rows: TruckRow[]) {
    let imported = 0;
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      const { error } = await supabase
        .from("fleet_trucks")
        .upsert(batch, { onConflict: "truck_number" });
      if (error) {
        throw new Error(`Batch starting at row ${i} failed: ${error.message}`);
      }
      imported += batch.length;
      console.log(`Imported ${imported}/${rows.length}`);
    }
    console.log(`Done. ${imported} truck(s) upserted.`);
  }
}

main();
