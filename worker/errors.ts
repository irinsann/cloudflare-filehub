import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
export function fail(status: ContentfulStatusCode, message: string): never {
  throw new HTTPException(status, { message });
}
