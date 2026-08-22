import { type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

// @supabase/ssr pulls in @supabase/supabase-js, which isn't guaranteed
// Edge-safe — run this on the Node.js runtime instead of the Edge default.
// Must be its own top-level export; Next.js does not read `runtime` from
// the `config` object below.
export const runtime = "nodejs";

export async function middleware(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
