import {
  CURRENT_STORAGE,
  HAS_AWS_S3_STORAGE,
  HAS_CLOUDBASE_STORAGE,
  HAS_CLOUDFLARE_R2_STORAGE,
  HAS_MINIO_STORAGE,
  HAS_VERCEL_BLOB_STORAGE,
} from '@/app/config';
import {
  StorageListResponse,
  StorageType,
  getFileNamePartsFromStorageUrl,
  storageTypeFromUrl,
} from '.';
import {
  awsS3Copy,
  awsS3Delete,
  awsS3GetSignedUrl,
  awsS3List,
  awsS3Put,
} from './aws-s3';
import {
  cloudflareR2Copy,
  cloudflareR2Delete,
  cloudflareR2GetSignedUrl,
  cloudflareR2List,
  cloudflareR2Put,
} from './cloudflare-r2';
import {
  minioCopy,
  minioDelete,
  minioGetSignedUrl,
  minioList,
  minioPut,
} from './minio';
import {
  cloudbaseStorageCopy,
  cloudbaseStorageDelete,
  cloudbaseStorageGetSignedUrl,
  cloudbaseStorageGetUploadTarget,
  cloudbaseStorageList,
  cloudbaseStoragePut,
} from './cloudbase-server';
import {
  vercelBlobCopy,
  vercelBlobDelete,
  vercelBlobList,
  vercelBlobPut,
} from './vercel-blob';
import { UploadTarget } from './cloudbase';

/**
 * Server-only storage operations.
 *
 * Kept apart from `./index` so that browser bundles never reach the
 * CloudBase Node SDK (or any other Node-only storage dependency).
 */

export type { StorageListResponse, StorageType } from '.';

export const putFile = (
  file: Buffer,
  fileName: string,
) => {
  switch (CURRENT_STORAGE) {
    case 'vercel-blob':
      return vercelBlobPut(file, fileName);
    case 'cloudflare-r2':
      return cloudflareR2Put(file, fileName);
    case 'aws-s3':
      return awsS3Put(file, fileName);
    case 'minio':
      return minioPut(file, fileName);
    case 'cloudbase-storage':
      return cloudbaseStoragePut(file, fileName);
  }
};

export const copyFile = (
  originUrl: string,
  destinationFileName: string,
): Promise<string> => {
  const { fileName } = getFileNamePartsFromStorageUrl(originUrl);
  switch (storageTypeFromUrl(originUrl)) {
    case 'vercel-blob':
      return vercelBlobCopy(originUrl, destinationFileName, false);
    case 'cloudflare-r2':
      return cloudflareR2Copy(fileName, destinationFileName, false);
    case 'aws-s3':
      return awsS3Copy(originUrl, destinationFileName, false);
    case 'minio':
      return minioCopy(fileName, destinationFileName, false);
    case 'cloudbase-storage':
      return cloudbaseStorageCopy(fileName, destinationFileName, false);
  }
};

export const deleteFile = (url: string) => {
  const { fileName } = getFileNamePartsFromStorageUrl(url);
  switch (storageTypeFromUrl(url)) {
    case 'vercel-blob':
      return vercelBlobDelete(url);
    case 'cloudflare-r2':
      return cloudflareR2Delete(fileName);
    case 'aws-s3':
      return awsS3Delete(fileName);
    case 'minio':
      return minioDelete(fileName);
    case 'cloudbase-storage':
      return cloudbaseStorageDelete(fileName);
  }
};

export const moveFile = async (
  originUrl: string,
  destinationFileName: string,
) => {
  const url = await copyFile(originUrl, destinationFileName);
  // If successful, delete original file
  if (url) { await deleteFile(originUrl); }
  return url;
};

export const getStorageUrlsForPrefix = async (prefix = '') => {
  const urls: StorageListResponse = [];

  if (HAS_VERCEL_BLOB_STORAGE) {
    urls.push(...await vercelBlobList(prefix).catch(() => []));
  }
  if (HAS_AWS_S3_STORAGE) {
    urls.push(...await awsS3List(prefix).catch(() => []));
  }
  if (HAS_CLOUDFLARE_R2_STORAGE) {
    urls.push(...await cloudflareR2List(prefix).catch(() => []));
  }
  if (HAS_MINIO_STORAGE) {
    urls.push(...await minioList(prefix).catch(() => []));
  }
  if (HAS_CLOUDBASE_STORAGE) {
    urls.push(...await cloudbaseStorageList(prefix).catch(() => []));
  }

  return urls.sort((a, b) => {
    if (!a.uploadedAt) { return 1; }
    if (!b.uploadedAt) { return -1; }
    return b.uploadedAt.getTime() - a.uploadedAt.getTime();
  });
};

export const deleteFilesWithPrefix = async (prefix: string) => {
  const urls = await getStorageUrlsForPrefix(prefix);
  return Promise.all(urls.map(({ url }) => deleteFile(url)));
};

// Used primarily for uploading files
export const getSignedUrlForKey = async (
  key: string,
  method: 'GET' | 'PUT',
  expiresIn = 3600,
) => {
  switch (CURRENT_STORAGE) {
    case 'cloudflare-r2':
      return cloudflareR2GetSignedUrl(key, method, expiresIn);
    case 'minio':
      return minioGetSignedUrl(key, method, expiresIn);
    case 'cloudbase-storage':
      return cloudbaseStorageGetUploadTarget(key).then(({ url }) => url);
    default:
      return awsS3GetSignedUrl(key, method, expiresIn);
  }
};

/**
 * Resolves everything the browser needs to upload a file directly to storage.
 */
export const getUploadTargetForKey = async (
  key: string,
): Promise<UploadTarget> =>
  CURRENT_STORAGE === 'cloudbase-storage'
    ? cloudbaseStorageGetUploadTarget(key)
    : { url: await getSignedUrlForKey(key, 'PUT') };

// Used for safely fetching files via presigned URLs
export const getSignedUrlForUrl = (
  url: string,
  method: 'GET' | 'PUT',
  expiresIn = 3600,
) => {
  const { fileName } = getFileNamePartsFromStorageUrl(url);
  switch (storageTypeFromUrl(url)) {
    case 'cloudflare-r2':
      return cloudflareR2GetSignedUrl(fileName, method, expiresIn);
    case 'minio':
      return minioGetSignedUrl(fileName, method, expiresIn);
    case 'aws-s3':
      return awsS3GetSignedUrl(fileName, method, expiresIn);
    case 'cloudbase-storage':
      return cloudbaseStorageGetSignedUrl(fileName, method, expiresIn);
    default:
      return url;
  }
};

export const testStorageConnection = () =>
  getStorageUrlsForPrefix();
