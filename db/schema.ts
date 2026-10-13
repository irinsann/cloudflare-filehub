import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
  primaryKey,
  type AnySQLiteColumn,
} from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
export const folders = sqliteTable(
  'folders',
  {
    id: text().primaryKey(),
    name: text().notNull(),
    parentId: text('parent_id').references((): AnySQLiteColumn => folders.id),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    deletedAt: integer('deleted_at'),
  },
  (t) => [
    index('folder_parent').on(t.parentId, t.deletedAt),
    uniqueIndex('folder_names')
      .on(sql`COALESCE(${t.parentId}, '')`, t.name)
      .where(sql`${t.deletedAt} IS NULL`),
  ],
);
export const files = sqliteTable(
  'files',
  {
    id: text().primaryKey(),
    name: text().notNull(),
    objectKey: text('object_key').notNull().unique(),
    folderId: text('folder_id').references(() => folders.id),
    mime: text().notNull(),
    size: integer().notNull().default(0),
    etag: text(),
    version: integer().notNull().default(1),
    status: text({ enum: ['pending', 'ready', 'deleting'] })
      .notNull()
      .default('pending'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    deletedAt: integer('deleted_at'),
  },
  (t) => [
    index('files_folder').on(t.folderId, t.deletedAt, t.status, t.updatedAt),
    index('files_recent').on(t.deletedAt, t.status, t.updatedAt),
  ],
);
export const fileShares = sqliteTable(
  'file_shares',
  {
    id: text().primaryKey(),
    fileId: text('file_id')
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    passwordHash: text('password_hash'),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at'),
    enabled: integer().notNull().default(1),
    allowDownload: integer('allow_download').notNull().default(1),
    views: integer().notNull().default(0),
    downloads: integer().notNull().default(0),
    lastAccessAt: integer('last_access_at'),
  },
  (t) => [index('shares_file').on(t.fileId)],
);
export const markdownPages = sqliteTable('markdown_pages', {
  id: text().primaryKey(),
  fileId: text('file_id')
    .notNull()
    .unique()
    .references(() => files.id, { onDelete: 'cascade' }),
  title: text().notNull(),
  slug: text().notNull().unique(),
  description: text().notNull().default(''),
  published: integer().notNull().default(0),
  publishedAt: integer('published_at'),
  updatedAt: integer('updated_at').notNull(),
  snapshotKey: text('snapshot_key'),
  publishedVersion: integer('published_version'),
  allowSource: integer('allow_source').notNull().default(0),
  allowIndex: integer('allow_index').notNull().default(0),
  views: integer().notNull().default(0),
});
export const markdownAttachments = sqliteTable(
  'markdown_attachments',
  {
    id: text().primaryKey(),
    fileId: text('file_id')
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
    objectKey: text('object_key').notNull().unique(),
    mime: text().notNull(),
    size: integer().notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('attachments_file').on(t.fileId)],
);
export const pageAttachments = sqliteTable(
  'page_attachments',
  {
    pageId: text('page_id')
      .notNull()
      .references(() => markdownPages.id, { onDelete: 'cascade' }),
    attachmentId: text('attachment_id')
      .notNull()
      .references(() => markdownAttachments.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.pageId, t.attachmentId] })],
);
export const operations = sqliteTable(
  'operations',
  {
    id: text().primaryKey(),
    action: text().notNull(),
    targetId: text('target_id').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('operations_time').on(t.createdAt)],
);
export const cleanupTasks = sqliteTable('cleanup_tasks', {
  objectKey: text('object_key').primaryKey(),
  createdAt: integer('created_at').notNull(),
  attempts: integer().notNull().default(0),
});
export const rateLimits = sqliteTable(
  'rate_limits',
  {
    key: text().primaryKey(),
    count: integer().notNull().default(1),
    resetAt: integer('reset_at').notNull(),
  },
  (t) => [index('rate_reset').on(t.resetAt)],
);
