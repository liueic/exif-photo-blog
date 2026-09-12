/** A single CloudBase query can return at most 1000 documents */
export const CLOUDBASE_QUERY_LIMIT = 1000;

type QueryLike = {
  skip: (offset: number) => QueryLike
  limit: (limit: number) => QueryLike
  get: () => Promise<{ data?: Record<string, any>[] }>
};

/**
 * Drains every match for a query by paging around the CloudBase per-request
 * document cap.
 *
 * `createQuery` must return a fresh query each call, because CloudBase query
 * objects are mutable and re-using one would accumulate `skip`/`limit` state.
 */
export const fetchAllPages = async <T extends Record<string, any>>(
  createQuery: () => QueryLike,
  {
    pageSize = CLOUDBASE_QUERY_LIMIT,
    max = 10000,
  }: { pageSize?: number, max?: number } = {},
): Promise<T[]> => {
  const documents: T[] = [];

  let offset = 0;
  while (offset < max) {
    const { data } = await createQuery()
      .skip(offset)
      .limit(pageSize)
      .get();

    const page = (data ?? []) as T[];
    documents.push(...page);

    if (page.length < pageSize) { break; }
    offset += pageSize;
  }

  return documents;
};
