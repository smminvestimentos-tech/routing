import "server-only";

// The TRACKiT client for use inside Next (Route Handlers, Server Components).
// The `server-only` import above makes an accidental client-bundle import a
// build error. All the actual logic lives in ./http (framework-free) so the
// one-off backfill script can reuse it without tripping that guard.
export * from "./http";
