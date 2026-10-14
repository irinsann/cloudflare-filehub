import type { Env } from './env';
import { now } from './env';

export async function recordImageAccess(
  env: Env,
  name: string,
  kind: 'reference' | 'download',
  request: Request,
  response: Response,
  expectedObjectKey?: string,
) {
  if (request.method !== 'GET' || response.status !== 200 || response.headers.has('Content-Range'))
    return;

  const column = kind === 'reference' ? 'views' : 'downloads';
  const objectCondition = expectedObjectKey === undefined ? '' : ' AND object_key=?';
  const parameters =
    expectedObjectKey === undefined ? [now(), name] : [now(), name, expectedObjectKey];
  // Match the served object so an in-flight response cannot count against a replacement.
  try {
    await env.DB.prepare(
      `UPDATE image_hosts SET ${column}=${column}+1,
         last_access_at=MAX(COALESCE(last_access_at,0),?)
       WHERE name=?${objectCondition}
         AND EXISTS(SELECT 1 FROM files f WHERE f.id=image_hosts.file_id
           AND f.object_key=image_hosts.object_key AND f.deleted_at IS NULL AND f.status='ready')`,
    )
      .bind(...parameters)
      .run();
  } catch (error) {
    console.error({
      event: 'image.stats_failed',
      kind,
      errorType:
        error instanceof TypeError ? 'TypeError' : error instanceof Error ? 'Error' : typeof error,
    });
  }
}
