import type { Metadata } from "next";
import { AzambujaSheetClient } from "./azambuja-sheet-client";

// Internal tool, no auth yet. Stateless — the upload is processed in
// /api/azambuja-sheet and nothing is stored, so there's nothing to fetch here.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Folha Azambuja — Dashboard",
};

export default function AzambujaSheetPage() {
  return <AzambujaSheetClient />;
}
