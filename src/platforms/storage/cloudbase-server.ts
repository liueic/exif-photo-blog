import { getCloudbase } from '@/platforms/cloudbase';
import { StorageListResponse, generateStorageId } from '.';
import { CLOUDBASE_STORAGE_BASE_URL, UploadTarget } from './cloudbase';

/**
 * Server-only CloudBase storage operations.
 *
 * Everything here goes through the CloudBase Node SDK, which must never be
 * imported by a client module.
 */

const urlForKey = (key?: string) => `${CLOUDBASE_STORAGE_BASE_URL}/${key}`;

/**
 * CloudBase identifies objects with a bucket-qualified `cloud://` id for every
 * operation except upload, which takes a plain path.
 */
const cloudObjectIdFor = (key: string) =>
  `cloud://${process.env.CLOUDBASE_ENV}.` +
  `${process.env.NEXT_PUBLIC_CLOUDBASE_STORAGE_BUCKET}/${key}`;

export const cloudbaseStoragePut = async (
  file: Buffer,
  fileName: string,
): Promise<string> =>
  getCloudbase()
    .uploadFile({ cloudPath: fileName, fileContent: file })
    .then(() => urlForKey(fileName));

export const cloudbaseStorageCopy = async (
  fileNameSource: string,
  fileNameDestination: string,
  addRandomSuffix?: boolean,
) => {
  const name = fileNameSource.split('.')[0];
  const extension = fileNameSource.split('.')[1];
  const dstPath = addRandomSuffix
    ? `${name}-${generateStorageId()}.${extension}`
    : fileNameDestination;

  // The CloudBase copy API rejects a rename (it requires src and dst to share
  // a file name), so the object is streamed into its new path instead
  const { fileList } = await getCloudbase().getTempFileURL({
    fileList: [cloudObjectIdFor(fileNameSource)],
  });

  const sourceUrl = fileList?.[0]?.tempFileURL;
  if (!sourceUrl) {
    throw new Error(`Could not resolve storage url for ${fileNameSource}`);
  }

  const response = await fetch(sourceUrl);
  const fileContent = Buffer.from(new Uint8Array(await response.arrayBuffer()));

  await getCloudbase().uploadFile({ cloudPath: dstPath, fileContent });

  return urlForKey(fileNameDestination);
};

export const cloudbaseStorageDelete = async (fileName: string) => {
  // A missing object is reported per-file in the result rather than thrown
  await getCloudbase()
    .deleteFile({ fileList: [cloudObjectIdFor(fileName)] })
    .catch(() => undefined);
};

/**
 * CloudBase exposes no prefix-listing API, so storage housekeeping that needs
 * to enumerate objects (the admin "Uploads" orphan view) has nothing to show
 * for this provider. Photo file variants are addressed deterministically
 * instead — see `deleteFilesForPhotoUrl`.
 */
export const cloudbaseStorageList = async (
  _prefix: string,
): Promise<StorageListResponse> => [];

export const cloudbaseStorageGetUploadTarget = async (
  key: string,
): Promise<UploadTarget> => {
  const { data } = await getCloudbase().getUploadMetadata({ cloudPath: key });
  return {
    url: data.url,
    headers: {
      authorization: data.authorization,
      'x-cos-security-token': data.token,
      'x-cos-meta-fileid': data.cosFileId,
    },
  };
};

/**
 * Download URLs.
 *
 * The environment bucket is readable by all users, so the stable CDN url is
 * returned directly instead of a short-lived signed link.
 */
export const cloudbaseStorageGetSignedUrl = (
  key: string,
  _method: 'GET' | 'PUT',
  _expiresIn: number,
) => Promise.resolve(urlForKey(key));
