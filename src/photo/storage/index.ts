import {
  getNextImageUrlForRequest,
  NextImageSize,
} from '@/platforms/next-image';
import {
  ClientUploadOptions,
  generateFileNameWithId,
  getFileNamePartsFromStorageUrl,
  uploadFileFromClient,
} from '@/platforms/storage';

/**
 * Client-safe photo storage helpers.
 *
 * Operations that talk to a storage provider live in `./server` so that
 * browser bundles never reach Node-only dependencies.
 */

const PREFIX_PHOTO = 'photo';
const PREFIX_UPLOAD = 'upload';

const EXTENSION_DEFAULT = 'jpg';
const EXTENSION_OPTIMIZED = 'jpg';

// For the time being, make compatible with `next/image` sizes
const OPTIMIZED_FILE_SIZES = [{
  suffix: 'sm',
  size: 200,
  quality: 90,
}, {
  suffix: 'md',
  size: 640,
  quality: 90,
}, {
  suffix: 'lg',
  size: 1080,
  quality: 80,
}] as const satisfies {
  suffix: string
  size: NextImageSize
  quality: number
}[];

type OptimizedSuffix = (typeof OPTIMIZED_FILE_SIZES)[number]['suffix'];

const OPTIMIZED_SUFFIX_DEFAULT: OptimizedSuffix = 'md';

const getOptimizedFileName = ({
  fileNameBase,
  suffix,
}: {
  fileNameBase: string
  suffix: OptimizedSuffix
}) =>
  `${fileNameBase}-${suffix}.${EXTENSION_OPTIMIZED}`;

const getOptimizedUrl =({
  urlBase,
  fileNameBase,
  suffix,
}: {
  urlBase: string
  fileNameBase: string
  suffix: OptimizedSuffix
}) =>
  `${urlBase}/${getOptimizedFileName({ fileNameBase, suffix })}`;

export const getOptimizedPhotoFileMeta = (fileNameBase: string) =>
  OPTIMIZED_FILE_SIZES.map(({ suffix, ...rest }) => ({
    ...rest,
    fileName: getOptimizedFileName({ fileNameBase, suffix }),
  }));

export const getOptimizedUrlsFromPhotoUrl = (url: string) => {
  const { urlBase, fileNameBase } = getFileNamePartsFromStorageUrl(url);
  return getOptimizedPhotoFileMeta(fileNameBase).map(({ fileName }) =>
    `${urlBase}/${fileName}`);
};

export const generateRandomFileNameForPhoto = () =>
  generateFileNameWithId(PREFIX_PHOTO);

export const uploadTempPhotoFromClient = (
  file: File | Blob,
  extension = EXTENSION_DEFAULT,
  options?: ClientUploadOptions,
) =>
  uploadFileFromClient(file, PREFIX_UPLOAD, extension, true, options);

export const uploadPhotoFromClient = (
  file: File | Blob,
  extension = EXTENSION_DEFAULT,
  options?: ClientUploadOptions,
) =>
  uploadFileFromClient(file, PREFIX_PHOTO, extension, true, options);

const getSuffixFromNextImageSize = (nextSize: NextImageSize) =>
  OPTIMIZED_FILE_SIZES.find(({ size }) => size === nextSize)?.suffix
    ?? OPTIMIZED_SUFFIX_DEFAULT;

export const getOptimizedPhotoUrl = (
  args: Parameters<typeof getNextImageUrlForRequest>[0] & {
    useNextImage?: boolean
  },
) => {
  const { useNextImage = true } = args;
  const suffix = getSuffixFromNextImageSize(args.size);
  const {
    urlBase,
    fileNameBase,
  } = getFileNamePartsFromStorageUrl(args.imageUrl);
  return useNextImage
    ? getNextImageUrlForRequest(args)
    : getOptimizedUrl({ urlBase, fileNameBase, suffix });
};

// Generate small, low-bandwidth images for quick manipulations such as
// generating blur data or image thumbnails for AI text generation
export const getOptimizedPhotoUrlForManipulation = (
  imageUrl: string,
  addBypassSecret?: boolean,
) =>
  getOptimizedPhotoUrl({ imageUrl, addBypassSecret, size: 640 });

export const getOptimizedPhotoUrlForSuffix = (
  url: string,
  suffix: OptimizedSuffix,
) => {
  const { urlBase, fileNameBase } = getFileNamePartsFromStorageUrl(url);
  return getOptimizedUrl({ urlBase, fileNameBase, suffix });
};

const getTestOptimizedPhotoUrl = (url: string) =>
  getOptimizedPhotoUrlForSuffix(url, 'sm');

export const doesPhotoUrlHaveOptimizedFiles = async (url: string) =>
  fetch(getTestOptimizedPhotoUrl(url)).then(res => res.ok);
