import { auth } from '@/auth/server';
import { getUploadTargetForKey } from '@/platforms/storage/server';

export const dynamic = 'force-dynamic';

/**
 * Returns everything the browser needs to upload a file directly to storage.
 *
 * CloudBase/COS authorizes uploads with request headers, so the response is a
 * uniform `{ url, headers? }` payload rather than a bare presigned url.
 */
export async function GET(
  _: Request,
  { params }: { params: Promise<{ key: string }> },
) {
  const { key } = await params;

  const session = await auth();

  if (session?.user && key) {
    const target = await getUploadTargetForKey(key);
    return Response.json(target, {
      headers: { 'cache-control': 'no-store' },
    });
  } else {
    return new Response('Unauthorized request', { status: 401 });
  }
}
