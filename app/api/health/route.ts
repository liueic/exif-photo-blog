import { COLLECTION_PHOTOS, getDb } from '@/platforms/cloudbase';

// Probes live infrastructure, so it must never be cached
export const dynamic = 'force-dynamic';

/**
 * Liveness/readiness probe for the container platform.
 *
 * Reports whether the CloudBase document database is reachable along with the
 * presence (never the value) of the credentials the runtime needs.
 */
export async function GET() {
  const database = await getDb()
    .collection(COLLECTION_PHOTOS)
    .count()
    .then(({ total }) => ({ ok: true, photos: total ?? 0 }))
    .catch((error: any) => ({
      ok: false,
      error: `${error?.message ?? error}`,
    }));

  return Response.json({
    ready: database.ok,
    database,
    environment: {
      // Booleans only — no secret values are exposed
      hasEnvironmentId: Boolean(process.env.CLOUDBASE_ENV),
      hasApiKey: Boolean(
        process.env.CLOUDBASE_APIKEY || process.env.CLOUDBASE_API_KEY,
      ),
      hasTencentCloudKeyPair: Boolean(
        process.env.TENCENTCLOUD_SECRETID &&
        process.env.TENCENTCLOUD_SECRETKEY,
      ),
      hasCloudbaseAiApiKey: Boolean(
        process.env.CLOUDBASE_AI_API_KEY ||
        process.env.CLOUDBASE_APIKEY ||
        process.env.CLOUDBASE_API_KEY,
      ),
      hasCloudbaseAiModel: Boolean(process.env.CLOUDBASE_AI_MODEL),
      hasAuthSecret: Boolean(process.env.AUTH_SECRET),
      hasAdminUser: Boolean(
        process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD,
      ),
      hasStorageBucket: Boolean(
        process.env.NEXT_PUBLIC_CLOUDBASE_STORAGE_BUCKET,
      ),
      hasStorageDomain: Boolean(
        process.env.NEXT_PUBLIC_CLOUDBASE_STORAGE_DOMAIN,
      ),
    },
  }, {
    headers: { 'cache-control': 'no-store' },
  });
}
