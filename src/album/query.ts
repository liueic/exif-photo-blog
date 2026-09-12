import { randomUUID } from 'crypto';
import {
  COLLECTION_ALBUMS,
  COLLECTION_PHOTOS,
  getCommand,
  getDb,
} from '@/platforms/cloudbase';
import { Album, Albums, parseAlbumFromDb } from '.';
import { safelyQuery } from '@/db/query';
import {
  buildAlbumInsertDocument,
  buildAlbumUpdateDocument,
} from '@/db/derive';
import {
  parseAggregateList,
  parseDocument,
  parseDocuments,
} from '@/db/document';
import { fetchAllPages } from '@/db/paging';

const albumsCollection = () => getDb().collection(COLLECTION_ALBUMS);
const photosCollection = () => getDb().collection(COLLECTION_PHOTOS);

export const insertAlbum = (album: Omit<Album, 'id'>) =>
  safelyQuery(async () => {
    // Postgres generated this via `gen_random_uuid()`
    const id = randomUUID();
    await albumsCollection().doc(id).set(buildAlbumInsertDocument(album));
    return id;
  }, 'insertAlbum');

export const updateAlbum = (album: Album) =>
  safelyQuery(async () => {
    await albumsCollection().doc(album.id)
      .update(buildAlbumUpdateDocument(album));
  }, 'updateAlbum');

export const getAlbumFromSlug = (slug: string) =>
  safelyQuery(async () => {
    const { data } = await albumsCollection()
      .where({ slug })
      .limit(1)
      .get();
    const document = parseDocument<Record<string, unknown>>(data?.[0]);
    return document ? parseAlbumFromDb(document) : undefined;
  }, 'getAlbumFromSlug');

export const getAlbum = (id: string) =>
  safelyQuery(async () => {
    const { data } = await albumsCollection().doc(id).get();
    const document = parseDocument<Record<string, unknown>>(
      Array.isArray(data) ? data[0] : data,
    );
    return document ? parseAlbumFromDb(document) : undefined;
  }, 'getAlbum');

export const deleteAlbum = (id: string) =>
  safelyQuery(async () => {
    await albumsCollection().doc(id).delete();
    // Replaces `ON DELETE CASCADE` on the album_photo join table
    await photosCollection()
      .where({ albumIds: id })
      .update({ albumIds: getCommand().pull(id) });
  }, 'deleteAlbum');

export const getAlbumsWithMeta = () =>
  safelyQuery(async () => {
    const { data } = await albumsCollection()
      .orderBy('createdAt', 'desc')
      .limit(1000)
      .get();

    return parseDocuments<Record<string, any>>(data)
      .map((album): Albums[number] => ({
        album: parseAlbumFromDb(album),
        // Denormalized count replaces the previous LEFT JOIN + GROUP BY
        count: parseInt(`${album.photoCount ?? 0}`, 10),
        lastModified: album.updatedAt as Date,
      }));
  }, 'getAlbumsWithMeta');

export const clearPhotoAlbumIds = (photoId: string) =>
  safelyQuery(async () => {
    const { data } = await photosCollection()
      .doc(photoId)
      .field({ _id: true, albumIds: true })
      .get();

    const document = Array.isArray(data) ? data[0] : data;
    const previousAlbumIds = (document?.albumIds ?? []) as string[];

    await photosCollection().doc(photoId).update({ albumIds: [] });
    await syncAlbumsForIds(previousAlbumIds);
  }, 'clearPhotoAlbumIds');

/**
 * Assigns photos to albums.
 *
 * The previous `ON CONFLICT (album_id, photo_id) DO NOTHING` insert is
 * replaced by `$addToSet`, which is likewise idempotent.
 */
export const addPhotoAlbumIds = (photoIds: string[], albumIds: string[]) => {
  if (photoIds.length > 0 && albumIds.length > 0) {
    return safelyQuery(async () => {
      const _ = getCommand();

      await Promise.all(photoIds.flatMap(photoId =>
        albumIds.map(albumId =>
          photosCollection()
            .doc(photoId)
            // `$addToSet` accepts a single value; multiple values would be
            // stored as one array element
            .update({ albumIds: _.addToSet(albumId) })
            .catch(() => undefined))));

      await syncAlbumsForIds(albumIds);
    }, 'addPhotoAlbumIds');
  }
};

export const addPhotoAlbumId = (photoId: string, albumId: string) =>
  addPhotoAlbumIds([photoId], [albumId]);

export const getAlbumTitlesForPhoto = (photoId: string) =>
  safelyQuery(async () => {
    const { data } = await photosCollection()
      .doc(photoId)
      .field({ _id: true, albumIds: true })
      .get();

    const document = Array.isArray(data) ? data[0] : data;
    const albumIds = (document?.albumIds ?? []) as string[];

    if (albumIds.length === 0) { return []; }

    const { data: albums } = await albumsCollection()
      .where({ _id: getCommand().in(albumIds) })
      // Preserve the stored album order rather than index order
      .field({ _id: true, title: true })
      .limit(albumIds.length)
      .get();

    const titlesById = new Map<string, string>(
      (albums ?? []).map(({ _id, title }) => [_id as string, title as string]),
    );

    return albumIds
      .map(albumId => titlesById.get(albumId))
      .filter((title): title is string => Boolean(title));
  }, 'getAlbumTitlesForPhoto');

export const getTagsForAlbum = (albumId: string) =>
  safelyQuery(async () => {
    // Reads the denormalized tag list rather than re-joining photos
    const { data } = await albumsCollection()
      .doc(albumId)
      .field({ _id: true, tags: true })
      .get();

    const document = Array.isArray(data) ? data[0] : data;

    return ((document?.tags ?? []) as string[]);
  }, 'getTagsForAlbum');

/**
 * Recomputes the denormalized album fields (`photoCount`, `tags`) that
 * replace the former `album_photo` join table.
 */
export const syncAlbumsForIds = async (albumIds: string[]) => {
  const uniqueAlbumIds = [...new Set(albumIds.filter(Boolean))];

  await Promise.all(uniqueAlbumIds.map(async albumId => {
    const photoCount = await photosCollection()
      .where({ albumIds: albumId })
      .count()
      .then(({ total }) => parseInt(`${total ?? 0}`, 10))
      .catch(() => 0);

    // `$unwind` + `$group` replaces `SELECT DISTINCT unnest(p.tags)`
    const list = await photosCollection()
      .aggregate()
      .match({ albumIds: albumId })
      .unwind('$tags')
      .group({ _id: '$tags' })
      .end()
      .then(result => parseAggregateList<{ _id: string }>(result));

    const tags = list
      .map(({ _id }) => _id)
      .filter((tag): tag is string => Boolean(tag))
      .sort();

    await albumsCollection().doc(albumId).update({
      photoCount,
      tags,
      updatedAt: new Date(),
    }).catch(() => undefined);
  }));
};

/** Full album list, used by data backfills */
export const getAllAlbumIds = () =>
  fetchAllPages<Record<string, any>>(() => albumsCollection())
    .then(albums => albums.map(({ _id }) => _id as string));
