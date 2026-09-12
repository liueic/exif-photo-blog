import {
  VERCEL_BLOB_BASE_URL,
  vercelBlobUploadFromClient,
} from './vercel-blob';
import { AWS_S3_BASE_URL, isUrlFromAwsS3 } from './aws-s3';
import { CURRENT_STORAGE } from '@/app/config';
import { generateNanoid } from '@/utility/nanoid';
import {
  CLOUDFLARE_R2_BASE_URL_PUBLIC,
  isUrlFromCloudflareR2,
} from './cloudflare-r2';
import { MINIO_BASE_URL, isUrlFromMinio } from './minio';
import {
  CLOUDBASE_STORAGE_BASE_URL,
  isUrlFromCloudbaseStorage,
} from './cloudbase';
import { PATH_API_PRESIGNED_URL } from '@/app/path';
import type { UploadTarget } from './cloudbase';

export type { UploadTarget } from './cloudbase';

/**
 * Client-safe storage surface.
 *
 * Anything that talks to a storage provider's SDK lives in `./server` — this
 * module is imported by browser components, so it may only pull in public
 * configuration and url helpers.
 */

export type StorageListItem = {
  url: string
  fileName: string
  uploadedAt?: Date
  size?: string
};

export type StorageListResponse = StorageListItem[];

export type StorageType =
  'vercel-blob' |
  'aws-s3' |
  'cloudflare-r2' |
  'minio' |
  'cloudbase-storage';

export type ClientUploadOptions = {
  onProgress?: (loaded: number, total: number) => void
  abortSignal?: AbortSignal
};

export const generateStorageId = () => generateNanoid(16);

export const generateFileNameWithId = (prefix: string) =>
  `${prefix}-${generateStorageId()}`;

export const getFileNamePartsFromStorageUrl = (url: string) => {
  const [
    _,
    urlBase = '',
    fileName = '',
    fileNameBase = '',
    fileId = '',
    fileModifier = '',
    fileExtension = '',
  ] = url.match(
    /^(.+)\/((-*[a-z0-9]+-*([a-z0-9]+)-*([a-z0-9]+)*)\.([a-z]{1,4}))$/i,
  ) ?? [];
  return {
    urlBase,
    fileName,
    fileNameBase,
    fileId,
    fileModifier,
    fileExtension,
  };
};

export const labelForStorage = (type: StorageType): string => {
  switch (type) {
    case 'vercel-blob': return 'Vercel Blob';
    case 'cloudflare-r2': return 'Cloudflare R2';
    case 'aws-s3': return 'AWS S3';
    case 'minio': return 'MinIO';
    case 'cloudbase-storage': return 'CloudBase Storage';
  }
};

export const baseUrlForStorage = (type: StorageType) => {
  switch (type) {
    case 'vercel-blob': return VERCEL_BLOB_BASE_URL;
    case 'cloudflare-r2': return CLOUDFLARE_R2_BASE_URL_PUBLIC;
    case 'aws-s3': return AWS_S3_BASE_URL;
    case 'minio': return MINIO_BASE_URL;
    case 'cloudbase-storage': return CLOUDBASE_STORAGE_BASE_URL;
  }
};

export const storageTypeFromUrl = (url: string): StorageType => {
  if (isUrlFromCloudbaseStorage(url)) {
    return 'cloudbase-storage';
  } else if (isUrlFromCloudflareR2(url)) {
    return 'cloudflare-r2';
  } else if (isUrlFromAwsS3(url)) {
    return 'aws-s3';
  } else if (isUrlFromMinio(url)) {
    return 'minio';
  } else {
    return 'vercel-blob';
  }
};

const putBlobWithProgress = (
  url: string,
  file: File | Blob,
  {
    onProgress,
    abortSignal,
  }: ClientUploadOptions = {},
  headers?: Record<string, string>,
) =>
  new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    Object.entries(headers ?? {}).forEach(([key, value]) => {
      xhr.setRequestHeader(key, value);
    });
    xhr.upload.onprogress = event => {
      if (event.lengthComputable) {
        onProgress?.(event.loaded, event.total);
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        reject(new Error(`Upload failed with status ${xhr.status}`));
      }
    };
    xhr.onerror = () => reject(new Error('Upload failed'));
    xhr.onabort = () =>
      reject(new DOMException('The operation was aborted.', 'AbortError'));

    if (abortSignal?.aborted) {
      reject(new DOMException('The operation was aborted.', 'AbortError'));
      return;
    }
    const onAbort = () => xhr.abort();
    abortSignal?.addEventListener('abort', onAbort);
    xhr.onloadend = () => abortSignal?.removeEventListener('abort', onAbort);
    xhr.send(file);
  });

export const uploadFromClientViaPresignedUrl = async (
  file: File | Blob,
  fileName: string,
  options?: ClientUploadOptions,
) => {
  // Providers that authorize uploads with request headers return an
  // `UploadTarget`; others return a self-contained presigned url
  const target: UploadTarget = await fetch(
    `${PATH_API_PRESIGNED_URL}/${fileName}`,
    { signal: options?.abortSignal },
  )
    .then((response) => response.json());

  await putBlobWithProgress(target.url, file, options, target.headers);

  return `${baseUrlForStorage(CURRENT_STORAGE)}/${fileName}`;
};

export const uploadFileFromClient = async (
  file: File | Blob,
  _fileName: string,
  extension: string,
  addRandomSuffix = true,
  options?: ClientUploadOptions,
) => {
  const fileName = addRandomSuffix
    ? `${_fileName}-${generateStorageId()}.${extension}`
    : `${_fileName}.${extension}`;

  return CURRENT_STORAGE === 'vercel-blob'
    ? vercelBlobUploadFromClient(file, fileName, options)
    : uploadFromClientViaPresignedUrl(file, fileName, options);
};
