import {
  COLLECTION_ALBUMS,
  COLLECTION_PHOTOS,
  getDb,
} from '@/platforms/cloudbase';
import { derivePhotoFields } from './derive';
import { fetchAllPages } from './paging';
import { syncAlbumsForIds } from '@/album/query';

/**
 * Backfills the denormalized/indexed fields on every photo document.
 *
 * These fields (`takenAtYear`, `makeN`, `searchText`, ...) replace work that
 * Postgres previously did inside `WHERE` clauses, so they must exist on every
 * document for filtering and sorting to behave correctly.
 */
export const backfillDerivedPhotoFields = async () => {
  const collection = getDb().collection(COLLECTION_PHOTOS);

  const photos = await fetchAllPages<Record<string, any>>(
    () => collection,
  );

  let updated = 0;

  for (const photo of photos) {
    const derived = derivePhotoFields({
      takenAt: photo.takenAt?.toISOString?.() ?? photo.takenAt,
      make: photo.make ?? undefined,
      model: photo.model ?? undefined,
      lensMake: photo.lensMake ?? undefined,
      lensModel: photo.lensModel ?? undefined,
      title: photo.title ?? undefined,
      caption: photo.caption ?? undefined,
      semanticDescription: photo.semanticDescription ?? undefined,
      priorityOrder: photo.priorityOrder ?? undefined,
    });

    const update: Record<string, unknown> = { ...derived };

    // A missing/invalid capture date cannot be turned into a year
    if (Number.isNaN(derived.takenAtYear)) {
      delete update.takenAtYear;
    }

    await collection.doc(photo._id).update(update);
    updated++;
  }

  return { scanned: photos.length, updated };
};

/**
 * Recomputes the denormalized `photoCount`/`tags` fields on every album.
 */
export const backfillAlbumDenormalizedFields = async () => {
  const albums = await fetchAllPages<Record<string, any>>(
    () => getDb().collection(COLLECTION_ALBUMS),
  );

  await syncAlbumsForIds(albums.map(({ _id }) => _id as string));

  return albums.length;
};

/** Full data repair pass: photos first, then album denormalization */
export const backfillAllDerivedFields = async () => {
  const photos = await backfillDerivedPhotoFields();
  const albums = await backfillAlbumDenormalizedFields();
  return { photos, albums };
};
