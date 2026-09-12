/* eslint-disable max-len */
import {
  COLLECTION_PHOTOS,
  getCommand,
  getDb,
} from '@/platforms/cloudbase';
import {
  PhotoDb,
  PhotoDbInsert,
  translatePhotoId,
  parsePhotoFromDb,
  Photo,
  PhotoDateRangePostgres,
} from '@/photo';
import { Cameras, createCameraKey } from '@/camera';
import { Tags } from '@/tag';
import { Films } from '@/film';
import {
  AI_TEXT_AUTO_GENERATED_FIELDS,
  AI_CONTENT_GENERATION_ENABLED,
  COLOR_SORT_ENABLED,
} from '@/app/config';
import {
  CLOUDBASE_QUERY_LIMIT,
  OrderByClause,
  PhotoQueryOptions,
  WhereClause,
  applyRandomStrideOrder,
  applyWhere,
  getLimitAndOffsetFromOptions,
  getOrderByFromOptions,
  getRecentWindow,
  getWheresFromOptions,
  isEmptyWhere,
} from '../db';
import { FocalLengths } from '@/focal';
import { Lenses, createLensKey } from '@/lens';
import {
  UPDATE_QUERY_LIMIT,
  OUTDATED_UPDATE_AT_THRESHOLD,
} from '@/photo/update';
import { Recipes } from '@/recipe';
import { Years } from '@/year';
import { PhotoColorData } from '@/photo/color/client';
import { safelyQuery } from '@/db/query';
import {
  parseAggregateList,
  parseDocument,
  parseDocuments,
} from '@/db/document';
import {
  buildPhotoInsertDocument,
  buildPhotoUpdateDocument,
  parseJsonField,
  recipeDataKeyFor,
} from '@/db/derive';
import { syncAlbumsForIds } from '@/album/query';

type Document = Record<string, any>;

// CloudBase query objects are mutable and chainable; using `any` here keeps
// the builders readable without re-declaring the SDK's generics
type AnyQuery = any;

const photosCollection = () => getDb().collection(COLLECTION_PHOTOS);

/** Normalizes the aggregate result envelope into a list of rows */
const aggregateList = (result: unknown) => parseAggregateList<Document>(result);

/** Builds a query, omitting `where()` when there is nothing to filter on */
const photosQuery = (where: WhereClause): AnyQuery =>
  isEmptyWhere(where)
    ? photosCollection()
    : photosCollection().where(where);

const withOrderBy = (query: AnyQuery, orderBy: OrderByClause): AnyQuery =>
  orderBy.reduce(
    (acc, [field, direction]) => acc.orderBy(field, direction),
    query,
  );

/**
 * Resolves query conditions, expanding `recent` into a concrete `createdAt`
 * bound (it was a correlated subquery in SQL).
 */
const whereForOptions = async (options: PhotoQueryOptions) => {
  const where = getWheresFromOptions(options);

  if (options.recent) {
    const window = await getRecentWindow();
    if (window.excluded) {
      return { excluded: true as const, where };
    }
    applyWhere(where, 'createdAt', getCommand().gte(window.createdAtGte));
  }

  return { excluded: false as const, where };
};

/**
 * Album membership/tag lists are denormalized onto album documents, so any
 * mutation touching tags must resync the affected albums.
 */
const getAlbumIdsForTag = async (tag: string) => {
  const { data } = await photosCollection()
    .where({ tags: tag })
    .field({ _id: true, albumIds: true })
    .limit(CLOUDBASE_QUERY_LIMIT)
    .get();

  return ((data ?? []) as Document[])
    .flatMap(({ albumIds }) => (albumIds ?? []) as string[]);
};

// PHOTO WRITES

// Must provide id as 8-character nanoid
export const insertPhoto = (photo: PhotoDbInsert) =>
  safelyQuery(() => photosCollection()
    .doc(photo.id)
    .set(buildPhotoInsertDocument(photo))
    .then(() => undefined)
  , 'insertPhoto');

export const updatePhoto = (photo: PhotoDbInsert) =>
  safelyQuery(() => photosCollection()
    .doc(photo.id)
    .update(buildPhotoUpdateDocument(photo))
    .then(() => undefined)
  , 'updatePhoto');

export const updatePhotoTitleCaption = (
  photoIds: string[],
  titles: (string | null)[],
  captions: (string | null)[],
) => {
  if (photoIds.length === 0) {
    return Promise.resolve();
  }

  return safelyQuery(async () => {
    const updatedAt = new Date();
    await Promise.all(photoIds.map((id, index) =>
      photosCollection().doc(id).update({
        title: titles[index] ?? null,
        caption: captions[index] ?? null,
        updatedAt,
      })
        // The document may have been removed concurrently
        .catch(() => undefined)));
  }, 'updatePhotoTitleCaption');
};

export const deletePhotoTagGlobally = (tag: string) =>
  safelyQuery(async () => {
    const _ = getCommand();

    const affectedAlbumIds = await getAlbumIdsForTag(tag);

    // Replaces `tags = ARRAY_REMOVE(tags, $1) WHERE $1 = ANY(tags)`
    await photosCollection()
      .where({ tags: tag })
      .update({ tags: _.pull(tag) });

    await syncAlbumsForIds(affectedAlbumIds);
  }, 'deletePhotoTagGlobally');

export const renamePhotoTagGlobally = (tag: string, updatedTag: string) =>
  safelyQuery(async () => {
    const affectedAlbumIds = await getAlbumIdsForTag(tag);

    // Postgres rewrote the array in one statement. Here the replacement is
    // computed per document and written with `set`, which also collapses any
    // duplicate that re-adding an existing tag would otherwise introduce.
    const { data } = await photosCollection()
      .where({ tags: tag })
      .field({ _id: true, tags: true })
      .limit(CLOUDBASE_QUERY_LIMIT)
      .get();

    const updatedAt = new Date();

    await Promise.all(((data ?? []) as Document[]).map(({ _id, tags }) => {
      const updatedTags = Array.from(new Set(
        (tags as string[]).map(existing =>
          existing === tag ? updatedTag : existing),
      ));
      return photosCollection().doc(_id as string)
        .update({ tags: updatedTags, updatedAt })
        .catch(() => undefined);
    }));

    await syncAlbumsForIds(affectedAlbumIds);
  }, 'renamePhotoTagGlobally');

export const setPhotoVisibilityForIds = (
  photoIds: string[],
  hidden: boolean,
  excludeFromFeeds: boolean,
) =>
  safelyQuery(async () => {
    if (photoIds.length === 0) { return; }
    await photosCollection()
      .where({ _id: getCommand().in(photoIds) })
      .update({
        hidden,
        excludeFromFeeds,
        updatedAt: new Date(),
      });
  }, 'setPhotoVisibilityForIds');

export const addTagsToPhotos = (tags: string[], photoIds: string[]) =>
  safelyQuery(async () => {
    if (tags.length === 0 || photoIds.length === 0) { return; }

    const _ = getCommand();
    const updatedAt = new Date();

    // `$addToSet` takes a single value, so each tag is applied separately.
    // It is idempotent, replacing the previous `array_agg(DISTINCT ...)`.
    await Promise.all(photoIds.flatMap(photoId =>
      tags.map(tag =>
        photosCollection().doc(photoId)
          .update({ tags: _.addToSet(tag), updatedAt })
          .catch(() => undefined))));
  }, 'addTagsToPhotos');

export const deletePhotoRecipeGlobally = (recipe: string) =>
  safelyQuery(async () => {
    await photosCollection()
      .where({ recipeTitle: recipe })
      .update({ recipeTitle: null, updatedAt: new Date() });
  }, 'deletePhotoRecipeGlobally');

export const renamePhotoRecipeGlobally = (
  recipe: string,
  updatedRecipe: string,
) =>
  safelyQuery(async () => {
    await photosCollection()
      .where({ recipeTitle: recipe })
      .update({ recipeTitle: updatedRecipe, updatedAt: new Date() });
  }, 'renamePhotoRecipeGlobally');

export const deletePhoto = (id: string) =>
  safelyQuery(async () => {
    const { data } = await photosCollection()
      .doc(id)
      .field({ _id: true, albumIds: true })
      .get()
      .catch(() => ({ data: undefined }));

    const document = Array.isArray(data) ? data[0] : data;
    const albumIds = (document?.albumIds ?? []) as string[];

    await photosCollection().doc(id).delete().catch(() => undefined);

    // Replaces `ON DELETE CASCADE` on the album_photo join table
    await syncAlbumsForIds(albumIds);
  }, 'deletePhoto');

export const getPhotosMostRecentUpdate = async () =>
  safelyQuery(async () => {
    const { data } = await photosCollection()
      .field({ _id: true, updatedAt: true })
      .orderBy('updatedAt', 'desc')
      .limit(1)
      .get();
    return data?.[0]?.updatedAt as Date | undefined;
  }, 'getPhotosMostRecentUpdate');

// CATEGORY AGGREGATES
//
// Every former `GROUP BY` ran against the single `photos` collection, so the
// aggregation pipeline replaces them 1:1 — no `$lookup` (join) is required.

export const getUniqueCameras = async () =>
  safelyQuery(async () => {
    const _ = getCommand();

    const list = await photosCollection()
      .aggregate()
      .match({
        hidden: _.neq(true),
        makeN: _.nin(['']),
        modelN: _.nin(['']),
      })
      .group({
        _id: { make: '$make', model: '$model' },
        count: { $sum: 1 },
        lastModified: { $max: '$updatedAt' },
      })
      .end()
      .then(aggregateList);

    return ((list ?? []) as {
      _id: { make: string, model: string },
      count: number,
      lastModified: Date,
    }[])
      // Mirrors `ORDER BY make || ' ' || model ASC`
      .sort((a, b) => `${a._id.make} ${a._id.model}`.localeCompare(
        `${b._id.make} ${b._id.model}`))
      .map(({ _id: { make, model }, count, lastModified }): Cameras[number] => ({
        cameraKey: createCameraKey({ make, model }),
        camera: { make, model },
        count,
        lastModified,
      }));
  }, 'getUniqueCameras');

export const getUniqueLenses = async () =>
  safelyQuery(async () => {
    const _ = getCommand();

    const list = await photosCollection()
      .aggregate()
      .match({
        hidden: _.neq(true),
        lensModelN: _.nin(['']),
      })
      .group({
        _id: { lensMake: '$lensMake', lensModel: '$lensModel' },
        count: { $sum: 1 },
        lastModified: { $max: '$updatedAt' },
      })
      .end()
      .then(aggregateList);

    const lenses = ((list ?? []) as {
      _id: { lensMake: string | null, lensModel: string },
      count: number,
      lastModified: Date,
    }[]).map(({ _id: { lensMake, lensModel }, count, lastModified }) => ({
      make: lensMake ?? undefined,
      model: lensModel,
      count,
      lastModified,
    }));

    // Mirrors `ORDER BY lens_make || ' ' || lens_model ASC`, where a missing
    // make produced a NULL sort key (`NULLS LAST` in Postgres)
    return lenses
      .sort((a, b) =>
        !a.make && !b.make
          ? a.model.localeCompare(b.model)
          : !a.make
            ? 1
            : !b.make
              ? -1
              : `${a.make} ${a.model}`.localeCompare(`${b.make} ${b.model}`))
      .map(({ make, model, count, lastModified }): Lenses[number] => ({
        lensKey: createLensKey({ make, model }),
        lens: { make, model },
        count,
        lastModified,
      }));
  }, 'getUniqueLenses');

export const getUniqueTags = async (includeHidden?: boolean) =>
  safelyQuery(async () => {
    const _ = getCommand();

    // Replaces `SELECT DISTINCT unnest(tags) ... GROUP BY tag`
    const list = await photosCollection()
      .aggregate()
      .match(includeHidden ? {} : { hidden: _.neq(true) })
      .unwind('$tags')
      .group({
        _id: '$tags',
        count: { $sum: 1 },
        lastModified: { $max: '$updatedAt' },
      })
      .end()
      .then(aggregateList);

    return ((list ?? []) as {
      _id: string,
      count: number,
      lastModified: Date,
    }[])
      .filter(({ _id }) => Boolean(_id))
      .sort((a, b) => a._id.localeCompare(b._id))
      .map(({ _id: tag, count, lastModified }): Tags[number] => ({
        tag,
        count,
        lastModified,
      }));
  }, 'getUniqueTags');

export const getUniqueRecipes = async () =>
  safelyQuery(async () => {
    const _ = getCommand();

    const list = await photosCollection()
      .aggregate()
      .match({ hidden: _.neq(true), recipeTitle: _.nin([null]) })
      .group({
        _id: '$recipeTitle',
        count: { $sum: 1 },
        lastModified: { $max: '$updatedAt' },
      })
      .end()
      .then(aggregateList);

    return ((list ?? []) as {
      _id: string,
      count: number,
      lastModified: Date,
    }[])
      .filter(({ _id }) => Boolean(_id))
      .sort((a, b) => a._id.localeCompare(b._id))
      .map(({ _id, count, lastModified }): Recipes[number] => ({
        recipe: _id,
        count,
        lastModified,
      }));
  }, 'getUniqueRecipes');

export const getUniqueYears = async () =>
  safelyQuery(async () => {
    const _ = getCommand();

    // Replaces `EXTRACT(YEAR FROM taken_at)`, precomputed onto `takenAtYear`
    const list = await photosCollection()
      .aggregate()
      .match({ hidden: _.neq(true), takenAtYear: _.nin([null]) })
      .group({
        _id: '$takenAtYear',
        count: { $sum: 1 },
        lastModified: { $max: '$updatedAt' },
      })
      .end()
      .then(aggregateList);

    return ((list ?? []) as {
      _id: number,
      count: number,
      lastModified: Date,
    }[])
      .filter(({ _id }) => Number.isFinite(_id))
      .sort((a, b) => b._id - a._id)
      // Postgres returned `EXTRACT(...)` as a string; the category is a
      // string throughout the app, so it is kept that way
      .map(({ _id: year, count, lastModified }): Years[number] => ({
        year: `${year}`,
        count,
        lastModified,
      }));
  }, 'getUniqueYears');

export const getRecipeTitleForData = async (
  data: string | object,
  film: string,
) =>
  safelyQuery(async () => {
    const { data: documents } = await photosCollection()
      .where({
        hidden: getCommand().neq(true),
        recipeDataKey: recipeDataKeyFor(data),
        film,
      })
      .field({ _id: true, recipeTitle: true })
      .limit(1)
      .get();

    return documents?.[0]?.recipeTitle as string | undefined;
  }, 'getRecipeTitleForData');

export const getRecipeDataForTitle = async (title: string) =>
  safelyQuery(async () => {
    const _ = getCommand();

    const { data } = await photosCollection()
      .where({
        hidden: _.neq(true),
        recipeTitle: title,
        // Replaces `recipe_data IS NOT NULL AND recipe_data::text <> 'null'`
        recipeDataKey: _.nin([null, 'null']),
      })
      .field({ _id: true, recipeData: true })
      .orderBy('takenAt', 'desc')
      .limit(1)
      .get();

    const recipeData = data?.[0]?.recipeData;

    return recipeData ? JSON.stringify(recipeData) : undefined;
  }, 'getRecipeDataForTitle');

export const getPhotosNeedingRecipeTitleCount = async (
  data: string,
  film: string,
  photoIdToExclude?: string,
) =>
  safelyQuery(async () => {
    const where: WhereClause = {
      recipeTitle: null,
      recipeDataKey: recipeDataKeyFor(data),
      film,
    };

    // Postgres evaluated `id <> NULL` to NULL, matching nothing, so the
    // exclusion is only applied when a photo is actually provided
    if (photoIdToExclude) {
      where._id = getCommand().neq(photoIdToExclude);
    }

    const { total } = await photosCollection().where(where).count();

    return parseInt(`${total ?? 0}`, 10);
  }, 'getPhotosNeedingRecipeTitleCount');

export const updateAllMatchingRecipeTitles = (
  title: string,
  data: string,
  film: string,
) =>
  safelyQuery(async () => {
    await photosCollection()
      .where({
        recipeTitle: null,
        recipeDataKey: recipeDataKeyFor(data),
        film,
      })
      .update({ recipeTitle: title, updatedAt: new Date() });
  }, 'updateAllMatchingRecipeTitles');

export const getUniqueFilms = async () =>
  safelyQuery(async () => {
    const _ = getCommand();

    const list = await photosCollection()
      .aggregate()
      .match({ hidden: _.neq(true), film: _.nin([null]) })
      .group({
        _id: '$film',
        count: { $sum: 1 },
        lastModified: { $max: '$updatedAt' },
      })
      .end()
      .then(aggregateList);

    return ((list ?? []) as {
      _id: string,
      count: number,
      lastModified: Date,
    }[])
      .filter(({ _id }) => Boolean(_id))
      .sort((a, b) => a._id.localeCompare(b._id))
      .map(({ _id: film, count, lastModified }): Films[number] => ({
        film,
        count,
        lastModified,
      }));
  }, 'getUniqueFilms');

export const getUniqueFocalLengths = async () =>
  safelyQuery(async () => {
    const _ = getCommand();

    const list = await photosCollection()
      .aggregate()
      .match({ hidden: _.neq(true), focalLength: _.nin([null]) })
      .group({
        _id: '$focalLength',
        count: { $sum: 1 },
        lastModified: { $max: '$updatedAt' },
      })
      .end()
      .then(aggregateList);

    return ((list ?? []) as {
      _id: number,
      count: number,
      lastModified: Date,
    }[])
      .filter(({ _id }) => Number.isFinite(_id))
      .sort((a, b) => a._id - b._id)
      .map(({ _id: focal, count, lastModified }): FocalLengths[number] => ({
        focal,
        count,
        lastModified,
      }));
  }, 'getUniqueFocalLengths');

// PHOTO READS

const _getPhotos = async (
  options: PhotoQueryOptions = {},
  projection?: Record<string, true>,
  {
    shouldParse = true,
  }: { shouldParse?: boolean } = {},
) => {
  const { excluded, where } = await whereForOptions(options);

  if (excluded) {
    return { photos: [] as any[], count: 0 };
  }

  const { limit, offset } = getLimitAndOffsetFromOptions(options);
  const isRandom = options.sortBy === 'random';

  const buildQuery = () => {
    const base = photosQuery(where);
    return withOrderBy(
      projection ? base.field(projection) : base,
      getOrderByFromOptions(options),
    );
  };

  // `random` is a stable recency *stride* rather than a true shuffle, and the
  // document store has no window functions — so the full ordered window is
  // fetched and strided in application code
  const { data } = await (isRandom
    ? buildQuery().limit(CLOUDBASE_QUERY_LIMIT)
    : buildQuery().skip(offset).limit(limit))
    .get();

  const documents = parseDocuments<Document>(data);

  const ordered = isRandom
    ? applyRandomStrideOrder(documents, limit).slice(offset, offset + limit)
    : documents;

  return {
    photos: shouldParse
      ? ordered.map(photo => parsePhotoFromDb(photo as PhotoDb))
      : ordered,
    count: ordered.length,
  };
};

export const getPhotos = async (options: PhotoQueryOptions = {}) =>
  safelyQuery(
    async () => _getPhotos(options).then(({ photos }) => photos),
    'getPhotos',
    // Seemingly necessary to pass `options` for expected cache behavior
    options,
  );

export const getPhotoIds = async (options: PhotoQueryOptions = {}) =>
  safelyQuery(
    async () => _getPhotos(
      options,
      { _id: true },
      { shouldParse: false },
    )
      .then(({ photos }) => photos.map(({ id }) => id as string)),
    'getPhotoIds',
    // Seemingly necessary to pass `options` for expected cache behavior
    options,
  );

export const getPhotoUrls = async (options: PhotoQueryOptions = {}) =>
  safelyQuery(
    async () => _getPhotos(
      options,
      { _id: true, title: true, url: true, hidden: true },
      { shouldParse: false },
    )
      .then(({ photos }) =>
        photos as {
          id: string,
          title: string,
          url: string,
          hidden?: boolean,
        }[]),
    'getPhotoUrls',
    // Seemingly necessary to pass `options` for expected cache behavior
    options,
  );

export const getPhotoCount = async (options: PhotoQueryOptions = {}) =>
  safelyQuery(
    async () => {
      const { excluded, where } = await whereForOptions(options);
      if (excluded) { return 0; }
      const { total } = await photosQuery(where).count();
      return parseInt(`${total ?? 0}`, 10);
    },
    'getPhotoCount',
    // Seemingly necessary to pass `options` for expected cache behavior
    options,
  );

/** Hydrates ids into parsed photos, preserving the requested order */
const getPhotosByIdsInOrder = async (ids: string[]) => {
  if (ids.length === 0) { return []; }

  const { data } = await photosCollection()
    .where({ _id: getCommand().in(ids) })
    .limit(ids.length)
    .get();

  const photosById = new Map(parseDocuments<Document>(data).map(document =>
    [document.id as string, document]));

  return ids
    .map(id => photosById.get(id))
    .filter((document): document is Document => Boolean(document))
    .map(document => parsePhotoFromDb(document as PhotoDb));
};

export const getPhotosNearId = async (
  photoId: string,
  options: PhotoQueryOptions,
) =>
  safelyQuery(async () => {
    const { limit = 100 } = options;

    const { excluded, where } = await whereForOptions(options);
    if (excluded) {
      return { photos: [] as Photo[], indexNumber: undefined as number | undefined };
    }

    // Replaces the `ROW_NUMBER() OVER (...)` CTE by resolving the ordered id
    // window in application code
    const { data } = await withOrderBy(
      photosQuery(where).field({ _id: true }),
      getOrderByFromOptions(options),
    )
      .limit(CLOUDBASE_QUERY_LIMIT)
      .get();

    const orderedIds = ((data ?? []) as Document[]).map(({ _id }) => _id);

    const ordered = options.sortBy === 'random'
      ? applyRandomStrideOrder(orderedIds, limit)
      : orderedIds;

    const index = ordered.indexOf(photoId);
    if (index === -1) {
      return { photos: [] as Photo[], indexNumber: undefined as number | undefined };
    }

    const start = Math.max(index - 1, 0);

    return {
      photos: await getPhotosByIdsInOrder(ordered.slice(start, start + limit)),
      // Matches the previous 1-based `row_number`
      indexNumber: index + 1 as number | undefined,
    };
  }, `getPhotosNearId: ${photoId}`);

export const getPhotosMeta = (options: PhotoQueryOptions = {}) =>
  safelyQuery(async () => {
    const { excluded, where } = await whereForOptions(options);

    if (excluded) { return { count: 0 }; }

    // `aggregate()` lives on the collection, not on a filtered query
    const aggregation = photosCollection().aggregate();

    const list = await (isEmptyWhere(where)
      ? aggregation
      : aggregation.match(where))
      .group({
        _id: null,
        count: { $sum: 1 },
        start: { $min: '$takenAtNaive' },
        end: { $max: '$takenAtNaive' },
        startCreatedAt: { $min: '$createdAt' },
        endCreatedAt: { $max: '$createdAt' },
      })
      .end()
      .then(aggregateList);

    const row = ((list ?? []) as Document[])[0] as {
      count?: number,
      start?: string,
      end?: string,
      startCreatedAt?: Date,
      endCreatedAt?: Date,
    } | undefined;

    return {
      count: row?.count ?? 0,
      ...row?.start && row?.end
        ? { dateRange: {
          start: row.start,
          end: row.end,
        } as PhotoDateRangePostgres }
        : undefined,
      // Used to calculate upload time for 'recents'
      ...row?.startCreatedAt && row?.endCreatedAt
        ? { dateRangeCreatedAt: {
          start: row.startCreatedAt as unknown as string,
          end: row.endCreatedAt as unknown as string,
        } as PhotoDateRangePostgres }
        : undefined,
    };
  }, 'getPhotosMeta');

export const getAllPublicPhotoIds = async ({ limit }: { limit?: number }) =>
  safelyQuery(async () => {
    let query: AnyQuery = photosCollection()
      .where({ hidden: getCommand().neq(true) })
      .field({ _id: true });

    if (limit) {
      query = query.limit(Math.min(limit, CLOUDBASE_QUERY_LIMIT));
    }

    const { data } = await query.get();

    return ((data ?? []) as Document[]).map(({ _id }) => _id as string);
  }, 'getPublicPhotoIds');

export const getAllPhotoIdsWithUpdatedAt = async () =>
  safelyQuery(async () => {
    const { data } = await photosCollection()
      .where({ hidden: getCommand().neq(true) })
      .field({ _id: true, updatedAt: true })
      .limit(CLOUDBASE_QUERY_LIMIT)
      .get();

    return ((data ?? []) as Document[]).map(({ _id, updatedAt }) => ({
      id: _id as string,
      updatedAt: updatedAt as Date,
    }));
  }, 'getPhotoIdsAndUpdatedAt');

export const getPhoto = async (
  id: string,
  includeHidden?: boolean,
): Promise<Photo | undefined> =>
  safelyQuery(async () => {
    // Check for photo id forwarding and convert short ids to uuids
    const photoId = translatePhotoId(id);

    const { data } = await photosCollection()
      .doc(photoId)
      .get()
      .catch(() => ({ data: undefined as Document[] | undefined }));

    const photo = parseDocument<PhotoDb>(
      Array.isArray(data) ? data[0] : data,
    );

    if (!photo) { return undefined; }
    if (!includeHidden && photo.hidden === true) { return undefined; }

    return parsePhotoFromDb(photo);
  }, 'getPhoto');

// UPDATE QUEUE

const aiTextWhereClauses = () => {
  const _ = getCommand();
  return AI_CONTENT_GENERATION_ENABLED
    ? AI_TEXT_AUTO_GENERATED_FIELDS
      .map(field => {
        switch (field) {
          case 'title':
            return _.or(
              { title: _.exists(false) },
              { title: null },
              { title: '' },
            );
          case 'caption':
            return _.or(
              { caption: _.exists(false) },
              { caption: null },
              { caption: '' },
            );
          case 'tags':
            // Replaces `tags IS NULL OR array_length(tags, 1) = 0`
            return _.or(
              { tags: _.exists(false) },
              { tags: null },
              { tags: [] },
            );
          case 'semantic':
            return _.or(
              { semanticDescription: _.exists(false) },
              { semanticDescription: null },
              { semanticDescription: '' },
            );
          default:
            return undefined;
        }
      })
      .filter(Boolean)
    : [];
};

const colorDataWhereClauses = () => {
  if (!COLOR_SORT_ENABLED) { return []; }
  const _ = getCommand();
  return [_.or(
    { colorData: _.exists(false) },
    { colorData: null },
    { colorSort: _.exists(false) },
    { colorSort: null },
  )];
};

const needsSyncWhereStatement = () => {
  const _ = getCommand();
  return _.or([
    { updatedAt: _.lt(OUTDATED_UPDATE_AT_THRESHOLD) },
    ...aiTextWhereClauses(),
    ...colorDataWhereClauses(),
  ]);
};

export const getPhotosInNeedOfUpdate = () =>
  safelyQuery(
    async () => {
      const { data } = await photosCollection()
        .where(needsSyncWhereStatement())
        .orderBy('createdAt', 'desc')
        .limit(UPDATE_QUERY_LIMIT)
        .get();

      return parseDocuments<PhotoDb>(data).map(parsePhotoFromDb);
    },
    'getPhotosInNeedOfUpdate',
  );

export const getPhotosInNeedOfUpdateCount = () =>
  safelyQuery(
    async () => {
      const { total } = await photosCollection()
        .where(needsSyncWhereStatement())
        .count();
      return parseInt(`${total ?? 0}`, 10);
    },
    'getPhotosInNeedOfUpdateCount',
  );

// BACKFILLS AND EXPERIMENTATION

export const getColorDataForPhotos = () =>
  safelyQuery(async () => {
    const { data } = await photosCollection()
      .field({ _id: true, url: true, colorData: true })
      .limit(UPDATE_QUERY_LIMIT)
      .get();

    return ((data ?? []) as Document[]).map(({ _id, url, colorData }) => ({
      id: _id as string,
      url: url as string,
      colorData: parseJsonField<PhotoColorData>(colorData),
    }));
  }, 'getColorDataForPhotos');

export const updateColorDataForPhoto = (
  photoId: string,
  colorData: string,
  colorSort: number,
) =>
  safelyQuery(
    async () => {
      await photosCollection().doc(photoId).update({
        colorData: parseJsonField<PhotoColorData>(colorData) ?? null,
        colorSort,
        updatedAt: new Date(),
      });
    },
    'updateColorDataForPhoto',
  );
