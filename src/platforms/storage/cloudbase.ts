import { removeUrlProtocol } from '@/utility/url';

/**
 * Client-safe CloudBase storage helpers.
 *
 * Only public deployment values live here so that browser bundles never pull
 * in the CloudBase Node SDK. Server-side operations are in
 * `./cloudbase-server`.
 */

const CLOUDBASE_STORAGE_DOMAIN = removeUrlProtocol(
  process.env.NEXT_PUBLIC_CLOUDBASE_STORAGE_DOMAIN,
);

export const CLOUDBASE_STORAGE_BASE_URL = CLOUDBASE_STORAGE_DOMAIN
  ? `https://${CLOUDBASE_STORAGE_DOMAIN}`
  : undefined;

export const isUrlFromCloudbaseStorage = (url?: string) =>
  Boolean(CLOUDBASE_STORAGE_BASE_URL) &&
  Boolean(url?.startsWith(CLOUDBASE_STORAGE_BASE_URL as string));

/**
 * A presigned upload target.
 *
 * Tencent COS direct uploads are authorized with request headers rather than
 * a self-contained URL, so callers must forward `headers` on the PUT.
 */
export type UploadTarget = {
  url: string
  headers?: Record<string, string>
};
