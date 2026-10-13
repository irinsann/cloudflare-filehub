import { z } from 'zod';
export const filename = z
  .string()
  .trim()
  .min(1)
  .max(180)
  .refine(
    (s) => !/[\x00-\x1f\x7f/\\]/.test(s) && s !== '.' && s !== '..',
    '文件名不能包含路径或控制字符',
  );
export const identifier = z.uuid();
export const folderInput = z.object({
  name: filename,
  parent_id: identifier.nullable().default(null),
});
export const filePatch = z.object({
  name: filename.optional(),
  folder_id: identifier.nullable().optional(),
});
export const folderPatch = z.object({
  name: filename.optional(),
  parent_id: identifier.nullable().optional(),
});
const reserved = new Set([
  'api',
  'p',
  's',
  'assets',
  'favicon',
  'robots',
  'cdn-cgi',
  'index',
  'admin',
  'login',
]);
export const slugSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .refine((s) => !reserved.has(s), '此路径是系统保留路径');
export const publishInput = z.object({
  title: z.string().trim().min(1).max(180),
  slug: slugSchema,
  description: z.string().max(500).default(''),
  allow_source: z.boolean().default(false),
  allow_index: z.boolean().default(false),
  version: z.number().int().positive(),
});
export const shareInput = z.object({
  file_id: identifier,
  password: z.string().min(1).max(128).optional(),
  expires_at: z.number().int().positive().nullable().default(null),
  allow_download: z.boolean().default(true),
});
export const sharePatch = z.object({
  enabled: z.boolean().optional(),
  allow_download: z.boolean().optional(),
  expires_at: z.number().int().positive().nullable().optional(),
  password: z.string().min(1).max(128).nullable().optional(),
});
export const markdownInput = z.object({
  name: filename,
  folder_id: identifier.nullable().default(null),
  content: z.string().default('# 新文档\n\n从这里开始记录。\n'),
});
export const markdownUpdate = z.object({
  content: z.string(),
  version: z.number().int().positive(),
});
