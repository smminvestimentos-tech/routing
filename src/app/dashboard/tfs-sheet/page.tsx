import type { Metadata } from "next";
import { TfsSheetClient } from "./tfs-sheet-client";

// Internal tool, no auth yet. Stateless — the upload is processed in
// /api/tfs-sheet and nothing is stored, so there's nothing to fetch here.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Folha TFS — Dashboard",
};

export default function TfsSheetPage() {
  return <TfsSheetClient />;
}
