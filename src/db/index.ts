import { parameterize } from '@/utility/string';
import { PhotoSetCategory } from '@/category';
import { Camera } from '@/camera';
import { Lens } from '@/lens';
import { APP_DEFAULT_SORT_BY, SortBy } from '@/photo/sort';
import { Album } from '@/album';
import { getPathComponents } from '@/app/path';
import { getAlbumFromSlug } from '@/album/query';
import { getPhotoCount } from '@/photo/query';
import { isTagPrivate } from '@/tag';
import {
  COLLECTION_PHOTOS,
  getCommand,
  getDb,
  getRegExp,
} from '@/platforms/cloudbase';

export const GENERATE_STATIC_PARAMS_LIMIT = 1000;
export const PHOTO_DEFAULT_LIMIT = 100;
/** A single CloudBase query can return at most 1000 documents */
export const CLOUDBASE_QUERY_LIMIT = 1000;

export type PhotoQueryOptions = {
  sortBy?: SortBy
  sortWithPriority?: boolean
  limit?: number
  offset?: number
  query?: string
  maximumAspectRatio?: number
  takenBefore?: Date
  takenAfterInclusive?: Date
  updatedBefore?: Date
  excludeFromFeeds?: boolean
  hidden?: 'exclude' | 'include' | 'only'
} & Omit<PhotoSetCategory, 'camera' | 'lens' | 'album'> & {
  camera?: Partial<Camera>
  lens?: Partial<Lens>
  album?: Album
  photoIds?: string[]
};

export const areOptionsSensitive = (options: PhotoQueryOptions) =>
  options.hidden === 'include' || options.hidden === 'only';

// QUERY CONDITIONS

export type WhereClause = Record<string, unknown>;

export const isEmptyWhere = (where: WhereClause) =>
  Object.keys(where).length === 0;

/** Combines repeated conditions on the same field (e.g. a date range) */
export const applyWhere = (
  where: WhereClause,
  field: string,
  value: unknown,
) => {
  const existing = where[field];
  where[field] = existing === undefined
    ? value
    : getCommand().and(existing as any, value as any);
};

export const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const getWheresFromOptions = (
  options: PhotoQueryOptions,
): WhereClause => {
  const {
    hidden = 'exclude',
    excludeFromFeeds,
    takenBefore,
    takenAfterInclusive,
    updatedBefore,
    query,
    maximumAspectRatio,
    year,
    album,
    tag,
    camera,
    lens,
    film,
    recipe,
    focal,
    photoIds,
  } = options;

  const _ = getCommand();
  const where: WhereClause = {};

  switch (hidden) {
    case 'exclude':
      // `hidden IS NOT TRUE` — also matches documents missing the field
      where.hidden = _.neq(true);
      break;
    case 'only':
      where.hidden = true;
      break;
  }

  if (excludeFromFeeds) {
    where.excludeFromFeeds = _.neq(true);
  }
  if (takenBefore) {
    applyWhere(where, 'takenAt', _.lt(takenBefore));
  }
  if (takenAfterInclusive) {
    applyWhere(where, 'takenAt', _.gte(takenAfterInclusive));
  }
  if (updatedBefore) {
    applyWhere(where, 'updatedAt', _.lt(updatedBefore));
  }
  if (query) {
    // Replaces
    // `CONCAT(title, ' ', caption, ' ', semantic_description) ILIKE ...`
    // via a denormalized, lowercased `searchText` field
    where.searchText = getRegExp(
      escapeRegExp(query.toLocaleLowerCase()),
      'i',
    );
  }
  if (maximumAspectRatio) {
    where.aspectRatio = _.lte(maximumAspectRatio);
  }
  if (year) {
    // Replaces `EXTRACT(YEAR FROM taken_at) = ...`. The category is a string
    // in the URL, while `takenAtYear` is stored as a number.
    const yearNumber = parseInt(year, 10);
    if (!Number.isNaN(yearNumber)) {
      where.takenAtYear = yearNumber;
    }
  }

  // Camera/lens matching uses denormalized, parameterized fields which replace
  // the `REGEXP_REPLACE(...)` normalization previously performed by Postgres
  const cameraMake = camera?.make ? parameterize(camera.make) : undefined;
  if (cameraMake) { where.makeN = cameraMake; }

  const cameraModel = camera?.model ? parameterize(camera.model) : undefined;
  if (cameraModel) { where.modelN = cameraModel; }

  const lensMake = lens?.make ? parameterize(lens.make) : undefined;
  if (lensMake) { where.lensMakeN = lensMake; }

  const lensModel = lens?.model ? parameterize(lens.model) : undefined;
  if (lensModel) {
    where.lensModelN = lensModel;
    // Ensure unique queries for lenses missing makes (`lens_make IS NULL`)
    if (!lensMake) { where.lensMakeN = ''; }
  }

  if (album) { where.albumIds = album.id; }
  if (tag) { where.tags = tag; }
  if (film) { where.film = film; }
  if (recipe) { where.recipeTitle = recipe; }
  if (focal) { where.focalLength = focal; }
  if (photoIds && photoIds.length > 0) { where._id = _.in(photoIds); }

  return where;
};

// ORDERING

export type OrderByClause = [string, 'asc' | 'desc'][];

export const getOrderByFromOptions = (
  options: PhotoQueryOptions,
): OrderByClause => {
  const {
    sortBy = APP_DEFAULT_SORT_BY,
    sortWithPriority,
  } = options;

  // Mirrors Postgres' `NULLS LAST` for ascending priority ordering
  const priority: OrderByClause =
    sortWithPriority ? [['priorityOrderSort', 'asc']] : [];

  switch (sortBy) {
    case 'takenAt':
      return [...priority, ['takenAt', 'desc']];
    case 'takenAtAsc':
      return [...priority, ['takenAt', 'asc']];
    case 'createdAt':
      return [...priority, ['createdAt', 'desc']];
    case 'createdAtAsc':
      return [...priority, ['createdAt', 'asc']];
    case 'color':
      // Date sort accounts for photos with the same color sort
      return [...priority, ['colorSort', 'desc'], ['takenAt', 'desc']];
    case 'colorAsc':
      return [...priority, ['colorSort', 'asc'], ['takenAt', 'asc']];
    case 'random':
      // Recency ordering only; the stable stride is applied in application
      // code (see `applyRandomStrideOrder`) because the document store has no
      // window functions
      return [['takenAt', 'desc'], ['_id', 'asc']];
  }
};

export const getRandomStride = (limit: number) =>
  Math.max(2, (Math.floor(Number(limit)) || 1) * 2);

/**
 * Replaces the original SQL window function:
 *
 * `ORDER BY (ROW_NUMBER() OVER (ORDER BY taken_at DESC, id) - 1) % stride,
 *           taken_at DESC, id`
 *
 * Expects input already ordered by `taken_at DESC, id`.
 */
export const applyRandomStrideOrder = <T>(
  items: T[],
  limit: number,
): T[] => {
  const stride = getRandomStride(limit);
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) =>
      (a.index % stride) - (b.index % stride) || a.index - b.index)
    .map(({ item }) => item);
};

// PAGING

export const getLimitAndOffsetFromOptions = (
  options: PhotoQueryOptions,
) => {
  const {
    limit = PHOTO_DEFAULT_LIMIT,
    offset = 0,
  } = options;

  return {
    limit: Math.min(
      Math.max(Math.floor(limit) || 0, 0),
      CLOUDBASE_QUERY_LIMIT,
    ),
    offset: Math.max(Math.floor(offset) || 0, 0),
  };
};

// 'RECENT' WINDOW

export type RecentWindow =
  | { excluded: true }
  | { excluded: false, createdAtGte: Date };

const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000;
const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Replaces the SQL subqueries:
 *
 * - `(SELECT MAX(created_at) FROM photos) >= (now() - INTERVAL '14 days')`
 * - `created_at >= (SELECT MAX(created_at) - INTERVAL '7 days' FROM photos)`
 */
export const getRecentWindow = async (): Promise<RecentWindow> => {
  const { data } = await getDb()
    .collection(COLLECTION_PHOTOS)
    .field({ _id: true, createdAt: true })
    .orderBy('createdAt', 'desc')
    .limit(1)
    .get();

  const newestCreatedAt = data?.[0]?.createdAt as Date | undefined;

  if (
    !newestCreatedAt ||
    new Date(newestCreatedAt).getTime() < Date.now() - TWO_WEEKS_MS
  ) {
    return { excluded: true };
  }

  return {
    excluded: false,
    createdAtGte: new Date(new Date(newestCreatedAt).getTime() - ONE_WEEK_MS),
  };
};

// DOCUMENT PARSING

export { parseDocument, parseDocuments } from './document';

// PATH HELPERS

export const getPhotoOptionsCountForPath = async (
  path: string,
): Promise<{ options: PhotoQueryOptions, count: number }> => {
  const { album: albumSlug, tag, ...components } = getPathComponents(path);

  let album: Album | undefined;
  if (albumSlug) {
    album = await getAlbumFromSlug(albumSlug);
  }

  const options: PhotoQueryOptions = {
    album,
    ...isTagPrivate(tag) ? { hidden: 'only' } : { tag },
    ...components,
  };

  const count = await getPhotoCount(options);

  // A single request cannot exceed the CloudBase per-query document cap, so
  // the caller pages through the result set rather than asking for `count`
  // documents in one go
  return {
    options: {
      ...options,
      limit: Math.min(count, CLOUDBASE_QUERY_LIMIT),
    },
    count,
  };
};
