import { DEFAULT_ASPECT_RATIO, type PhotoDbInsert } from '@/photo';
import type { Album } from '@/album';
import type { Place } from '@/place';
import { parameterize } from '@/utility/string';

/**
 * Sentinel used so that photos without an explicit priority order sort *after*
 * those with one. This mirrors Postgres' default `NULLS LAST` behavior for
 * `ORDER BY priority_order ASC`, which the document store cannot express
 * natively (missing fields sort first in ascending order).
 */
export const PRIORITY_ORDER_SORT_DEFAULT = Number.MAX_SAFE_INTEGER;

/**
 * Normalizes the various JSON shapes the app may hold (raw object, or a
 * stringified object) into a plain object. Postgres handled this implicitly
 * through its `jsonb` column type.
 */
export const parseJsonField = <T>(value: unknown): T | undefined => {
  if (value === undefined || value === null) { return undefined; }
  if (typeof value !== 'string') { return value as T; }
  if (value === 'null') { return undefined; }
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
};

/**
 * Stable identity for `recipeData`, used for equality lookups.
 *
 * Postgres compared `jsonb` values structurally; the document store compares
 * strings, so the raw serialized form is persisted alongside the parsed object.
 */
export const recipeDataKeyFor = (recipeData: unknown): string | null =>
  typeof recipeData === 'string'
    ? recipeData
    : recipeData === undefined || recipeData === null
      ? null
      : JSON.stringify(recipeData);

export type PhotoDerivedFields = {
  /** Mirrors `EXTRACT(YEAR FROM taken_at)` (evaluated in UTC) */
  takenAtYear: number
  /** Mirrors the `REGEXP_REPLACE`-based normalization previously done in SQL */
  makeN: string
  modelN: string
  lensMakeN: string
  lensModelN: string
  /** Lowercased title/caption/semantic concatenation for substring search */
  searchText: string
  /** Sort key giving `NULLS LAST` semantics for `priorityOrder` */
  priorityOrderSort: number
};

export const derivePhotoFields = (
  photo: Pick<
    Partial<PhotoDbInsert>,
    | 'takenAt'
    | 'make'
    | 'model'
    | 'lensMake'
    | 'lensModel'
    | 'title'
    | 'caption'
    | 'semanticDescription'
    | 'priorityOrder'
  >,
): PhotoDerivedFields => ({
  takenAtYear: photo.takenAt
    ? new Date(photo.takenAt).getUTCFullYear()
    : NaN,
  makeN: parameterize(photo.make ?? ''),
  modelN: parameterize(photo.model ?? ''),
  lensMakeN: parameterize(photo.lensMake ?? ''),
  lensModelN: parameterize(photo.lensModel ?? ''),
  searchText: [
    photo.title,
    photo.caption,
    photo.semanticDescription,
  ]
    .filter((value): value is string => Boolean(value))
    .join(' ')
    .toLocaleLowerCase(),
  priorityOrderSort:
    photo.priorityOrder !== undefined && photo.priorityOrder !== null
      ? photo.priorityOrder
      : PRIORITY_ORDER_SORT_DEFAULT,
});

/** Fields owned by the app rather than by a given insert/update payload */
type PhotoDocumentMeta = {
  albumIds?: string[]
  createdAt?: Date
  updatedAt?: Date
};

export type PhotoDocument = Record<string, unknown>;

const photoDocumentFields = (
  photo: PhotoDbInsert,
): PhotoDocument => ({
  url: photo.url,
  extension: photo.extension,
  width: photo.width ?? null,
  height: photo.height ?? null,
  aspectRatio: photo.aspectRatio ?? DEFAULT_ASPECT_RATIO,
  blurData: photo.blurData ?? null,
  title: photo.title ?? null,
  caption: photo.caption ?? null,
  semanticDescription: photo.semanticDescription ?? null,
  tags: photo.tags ?? [],
  make: photo.make ?? null,
  model: photo.model ?? null,
  focalLength: photo.focalLength ?? null,
  focalLengthIn35MmFormat: photo.focalLengthIn35MmFormat ?? null,
  lensMake: photo.lensMake ?? null,
  lensModel: photo.lensModel ?? null,
  fNumber: photo.fNumber ?? null,
  iso: photo.iso ?? null,
  exposureTime: photo.exposureTime ?? null,
  exposureCompensation: photo.exposureCompensation ?? null,
  locationName: photo.locationName ?? null,
  location: parseJsonField<Place>(photo.location) ?? null,
  latitude: photo.latitude ?? null,
  longitude: photo.longitude ?? null,
  film: photo.film ?? null,
  recipeTitle: photo.recipeTitle ?? null,
  recipeData: parseJsonField(photo.recipeData) ?? null,
  recipeDataKey: recipeDataKeyFor(photo.recipeData),
  colorData: parseJsonField(photo.colorData) ?? null,
  colorSort: photo.colorSort ?? null,
  priorityOrder: photo.priorityOrder ?? null,
  takenAt: new Date(photo.takenAt),
  takenAtNaive: photo.takenAtNaive,
  excludeFromFeeds: photo.excludeFromFeeds ?? false,
  hidden: photo.hidden ?? false,
  ...derivePhotoFields(photo),
});

export const buildPhotoInsertDocument = (
  photo: PhotoDbInsert,
  meta: PhotoDocumentMeta = {},
): PhotoDocument => {
  const now = new Date();
  return {
    ...photoDocumentFields(photo),
    albumIds: meta.albumIds ?? [],
    createdAt: meta.createdAt ?? now,
    updatedAt: meta.updatedAt ?? now,
  };
};

export const buildPhotoUpdateDocument = (
  photo: PhotoDbInsert,
): PhotoDocument => ({
  ...photoDocumentFields(photo),
  updatedAt: new Date(),
});

export type AlbumDocument = Record<string, unknown>;

export const buildAlbumInsertDocument = (album: Omit<Album, 'id'>) => {
  const now = new Date();
  return {
    title: album.title,
    slug: album.slug,
    subhead: album.subhead ?? null,
    description: album.description ?? null,
    location: parseJsonField<Place>(album.location) ?? null,
    // Denormalized, maintained by `syncAlbumsForPhotoIds`
    photoCount: 0,
    tags: [] as string[],
    createdAt: now,
    updatedAt: now,
  };
};

export const buildAlbumUpdateDocument = (album: Album) => ({
  title: album.title,
  slug: album.slug,
  subhead: album.subhead ?? null,
  description: album.description ?? null,
  location: parseJsonField<Place>(album.location) ?? null,
  updatedAt: new Date(),
});
