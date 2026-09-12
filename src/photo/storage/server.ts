import {
  StorageListResponse,
  copyFile,
  deleteFile,
  getSignedUrlForUrl,
  getStorageUrlsForPrefix,
  moveFile,
  putFile,
} from '@/platforms/storage/server';
import { removeGpsData, resizeImageToBytes } from '../server';
import {
  generateRandomFileNameForPhoto,
  getOptimizedPhotoFileMeta,
  getOptimizedPhotoUrl,
  getOptimizedPhotoUrlForSuffix,
  getOptimizedUrlsFromPhotoUrl,
} from '.';
import { Photo } from '..';
import { fetchBase64ImageFromUrl } from '@/utility/image';
import { NextImageSize } from '@/platforms/next-image';
import { getFileNamePartsFromStorageUrl } from '@/platforms/storage';

const PREFIX_PHOTO = 'photo';
const PREFIX_UPLOAD = 'upload';

export const storeOptimizedPhotosForUrl = async (
  url: string,
  _fileBytes?: ArrayBuffer,
) => {
  const fileBytes = _fileBytes
    ? _fileBytes
    : await fetch(url).then(res => res.arrayBuffer());
  const { fileNameBase } = getFileNamePartsFromStorageUrl(url);
  const optimizedPhotoFileMeta = getOptimizedPhotoFileMeta(fileNameBase);
  for (const { fileName, size, quality } of optimizedPhotoFileMeta) {
    await putFile(await resizeImageToBytes(fileBytes, size, quality), fileName);
  }
  return url;
};

export const convertUploadToPhoto = async ({
  uploadUrl,
  fileBytes: _fileBytes,
  shouldStripGpsData,
  shouldDeleteOrigin = true,
} : {
  uploadUrl: string
  fileBytes?: ArrayBuffer
  shouldStripGpsData?: boolean
  shouldDeleteOrigin?: boolean
}) => {
  const fileNameBase = generateRandomFileNameForPhoto();
  const { fileExtension } = getFileNamePartsFromStorageUrl(uploadUrl);
  const fileName = `${fileNameBase}.${fileExtension}`;
  const fileBytes = _fileBytes
    ? _fileBytes
    : await fetch(uploadUrl).then(res => res.arrayBuffer());
  let promise: Promise<string>;
  if (shouldStripGpsData) {
    const fileWithoutGps = await removeGpsData(fileBytes);
    promise = putFile(fileWithoutGps, fileName)
      .then(async url => {
        if (url && shouldDeleteOrigin) { await deleteFile(uploadUrl); }
        return url;
      });
  } else {
    promise = shouldDeleteOrigin
      ? moveFile(uploadUrl, fileName)
      : copyFile(uploadUrl, fileName);
  }
  // Store optimized photos after original photo is copied/moved
  const updatedUrl = await promise
    .then(async url => storeOptimizedPhotosForUrl(url, fileBytes));

  return updatedUrl;
};

// STORAGE QUERIES

export const getStorageUploadUrls = () =>
  getStorageUrlsForPrefix(`${PREFIX_UPLOAD}-`);

export const getStoragePhotoUrls = () =>
  getStorageUrlsForPrefix(`${PREFIX_PHOTO}-`);

/**
 * Deletes a photo plus every optimized variant it may have.
 *
 * Variant file names are deterministic (`<base>-sm|md|lg.jpg`), so this does
 * not depend on being able to list the bucket — which CloudBase storage does
 * not support.
 */
export const deleteFilesForPhotoUrl = async (url: string) =>
  Promise.all(
    [url, ...getOptimizedUrlsFromPhotoUrl(url)].map(candidate =>
      deleteFile(candidate).catch(() => undefined)),
  );

export const getStorageUrlsForPhoto = async ({ url }: Photo) => {
  const getSortScoreForUrl = (url: string) => {
    const { fileNameBase } = getFileNamePartsFromStorageUrl(url);
    if (fileNameBase.endsWith('-sm')) { return 1; }
    if (fileNameBase.endsWith('-md')) { return 2; }
    if (fileNameBase.endsWith('-lg')) { return 3; }
    return 0;
  };

  const { fileNameBase } = getFileNamePartsFromStorageUrl(url);

  return getStorageUrlsForPrefix(fileNameBase).then(urls =>
    urls.sort((a, b) => getSortScoreForUrl(a.url) - getSortScoreForUrl(b.url)),
  );
};

export const getDataUrlsForPhotos = async (
  photos: Photo[],
  optimizedSuffix: Parameters<typeof getOptimizedPhotoUrlForSuffix>[1],
  nextImageWidth: NextImageSize,
  addBypassSecret: boolean,
): Promise<{ id: string, urlData: string }[]> =>
  Promise.all(photos
    .map(async({ id, url }) => {
      // Check for optimized image first
      const optimizedUrl = await getSignedUrlForUrl(
        getOptimizedPhotoUrlForSuffix(url, optimizedSuffix),
        'GET',
      );
      const optimizedUrlData = await fetchBase64ImageFromUrl(optimizedUrl);

      if (optimizedUrlData) {
        return { id, urlData: optimizedUrlData };
      } else {
        // Fall back on `next/image` if optimized image is not available
        const nextImageUrl = getOptimizedPhotoUrl({
          imageUrl: url,
          size: nextImageWidth,
          addBypassSecret,
        });
        const nextImageUrlData = await fetchBase64ImageFromUrl(nextImageUrl);
        return { id, urlData: nextImageUrlData };
      }
    }))
    .then(urls => urls.every(({ urlData }) => Boolean(urlData))
      ? urls as { id: string, urlData: string }[]
      // If any url is undefined, return an empty array
      : []);

export type { StorageListResponse };
