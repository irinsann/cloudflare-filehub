import type { Context } from 'hono';
export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  ASSETS: Fetcher;
  ENVIRONMENT: string;
  LOCAL_AUTH: string;
  MAX_UPLOAD_BYTES: string;
  MAX_TEXT_BYTES: string;
  ADMIN_ORIGIN: string;
  FILES_ORIGIN: string;
  MARKDOWN_ORIGIN: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  ADMIN_EMAILS: string;
  SHARE_SESSION_SECRET: string;
}
export type AppEnv = { Bindings: Env; Variables: { email: string; requestId: string } };
export type AppContext = Context<AppEnv>;
export const now = () => Date.now();
export const uuid = () => crypto.randomUUID();
export const limit = (value: string, fallback: number) => {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
};
