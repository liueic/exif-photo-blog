/**
 * Normalizes a CloudBase document into the `id`-based shape the app expects.
 *
 * Documents are stored under `_id`; the rest of the codebase (and the UI)
 * speaks in terms of `id`, which previously came from a Postgres column.
 */
export const parseDocument = <T extends Record<string, any>>(
  document: Record<string, any> | undefined,
): T | undefined => {
  if (!document) { return undefined; }
  const { _id, ...rest } = document;
  return { ...rest, id: rest.id ?? _id } as unknown as T;
};

export const parseDocuments = <T extends Record<string, any>>(
  documents: Record<string, any>[] | undefined,
): T[] => (documents ?? []).map(document =>
  parseDocument<T>(document) as T);

/**
 * Result rows from `aggregate().end()`.
 *
 * The Node SDK resolves to `{ data: [...] }`, while some CloudBase SDK
 * versions (and the docs) call this field `list` — both are accepted so the
 * aggregation call sites do not depend on that detail.
 */
export const parseAggregateList = <T = Record<string, any>>(
  result: any,
): T[] => (result?.list ?? result?.data ?? []) as T[];
