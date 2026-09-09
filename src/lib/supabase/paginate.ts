import "server-only";

// PostgREST caps every response at the project's `db-max-rows` (1000 here),
// regardless of any `.limit(n)` on the query. To actually read more than 1000
// rows you have to page with Range headers. `.limit()` calls in the sync/sheet
// routes were silently truncating once a day's data grew past 1000 rows.
//
// `page(from, to)` must rebuild the query each call (Supabase builders are
// single-use) and apply `.range(from, to)` plus a stable `.order(...)`. Passing
// `{ count: "exact" }` on the select lets the first page report the total so
// the rest can be fetched concurrently.

type PageResult<T> = {
  data: T[] | null;
  error: { message: string } | null;
  count?: number | null;
};

export async function fetchAllRows<T>(
  page: (from: number, to: number) => PromiseLike<PageResult<T>>,
  opts: { pageSize?: number; concurrency?: number; hardCap?: number } = {},
): Promise<{ data: T[]; error: string | null }> {
  const pageSize = opts.pageSize ?? 1000;
  const concurrency = opts.concurrency ?? 6;
  const hardCap = opts.hardCap ?? 500_000;

  const first = await page(0, pageSize - 1);
  if (first.error) return { data: [], error: first.error.message };
  const head = first.data ?? [];
  const total = Math.min(
    typeof first.count === "number" ? first.count : head.length,
    hardCap,
  );
  if (head.length < pageSize || head.length >= total) {
    return { data: head, error: null };
  }

  const starts: number[] = [];
  for (let s = pageSize; s < total; s += pageSize) starts.push(s);

  const chunks: T[][] = new Array(starts.length);
  let errMsg: string | null = null;
  for (let i = 0; i < starts.length && !errMsg; i += concurrency) {
    const batch = starts.slice(i, i + concurrency);
    const results = await Promise.all(
      batch.map((s) => page(s, s + pageSize - 1)),
    );
    results.forEach((r, j) => {
      if (r.error) errMsg = errMsg ?? r.error.message;
      chunks[i + j] = r.data ?? [];
    });
  }
  if (errMsg) return { data: head, error: errMsg };

  return { data: head.concat(...chunks), error: null };
}
