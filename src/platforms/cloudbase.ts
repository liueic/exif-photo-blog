import tcb from '@cloudbase/node-sdk';

// Collection names
export const COLLECTION_PHOTOS = 'photos';
export const COLLECTION_ALBUMS = 'albums';
export const COLLECTION_ABOUT = 'about';

// Single fixed document id for the `about` collection
export const ABOUT_DOCUMENT_ID = 'about';

type CloudBaseApp = ReturnType<typeof tcb.init>;

let cached: CloudBaseApp | undefined;

/**
 * Lazily-initialized CloudBase app.
 *
 * `init` maintains an internal connection pool, so this must be created once
 * per process — always access it through this function rather than calling
 * `cloudbase.init` directly.
 *
 * On CloudBase Run (and Cloud Functions), `TENCENTCLOUD_SECRETID` /
 * `TENCENTCLOUD_SECRETKEY` are injected automatically and the SDK picks them up
 * on its own. They only need to be passed explicitly for local development or
 * non-CloudBase hosts.
 *
 * NOTE: this module holds admin-level credentials. It must never be imported
 * by a `'use client'` module.
 */
export const getCloudbase = (): CloudBaseApp => {
  if (!cached) {
    const env = process.env.CLOUDBASE_ENV;
    if (!env) {
      throw new Error('Missing environment variable: CLOUDBASE_ENV');
    }

    const secretId = process.env.TENCENTCLOUD_SECRETID;
    const secretKey = process.env.TENCENTCLOUD_SECRETKEY;

    cached = tcb.init({
      env,
      ...secretId && secretKey ? { secretId, secretKey } : {},
    });
  }
  return cached;
};

export const getDb = () => getCloudbase().database();

export const getCommand = () => getDb().command;

export const getRegExp = (
  regexp: string,
  options?: string,
) => getDb().RegExp({ regexp, options });

export const testDatabaseConnection = () =>
  getDb().collection(COLLECTION_PHOTOS).count();
