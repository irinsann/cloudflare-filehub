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
export * from './html-hosting-schema';
export * from './site-shares-schema';
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
    index('folders_site_path').on(t.parentId, t.name, t.deletedAt),
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
    index('files_site_path').on(t.folderId, t.name, t.deletedAt, t.status),
    index('files_dav_path').on(t.folderId, sql`${t.name} COLLATE NOCASE`, t.deletedAt),
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
export const markdownPages = sqliteTable(
  'markdown_pages',
  {
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
  },
  (t) => [
    index('pages_snapshot_key')
      .on(t.snapshotKey)
      .where(sql`${t.snapshotKey} IS NOT NULL`),
  ],
);
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
export const cleanupTasks = sqliteTable(
  'cleanup_tasks',
  {
    objectKey: text('object_key').primaryKey(),
    createdAt: integer('created_at').notNull(),
    attempts: integer().notNull().default(0),
    writerOwner: text('writer_owner'),
    generation: text().notNull().default(''),
  },
  (t) => [
    index('cleanup_created_at').on(t.createdAt),
    index('cleanup_retry_order').on(t.attempts, t.createdAt),
  ],
);
export const storageAllocations = sqliteTable('storage_allocations', {
  objectKey: text('object_key').primaryKey(),
  size: integer().notNull(),
});
export const storageQuotaState = sqliteTable('storage_quota_state', {
  id: integer().primaryKey(),
  ready: integer().notNull().default(0),
  lockUntil: integer('lock_until').notNull().default(0),
  usedBytes: integer('used_bytes').notNull().default(0),
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

export const uploadSessions = sqliteTable(
  'upload_sessions',
  {
    id: text().primaryKey(),
    fileId: text('file_id')
      .notNull()
      .unique()
      .references(() => files.id, { onDelete: 'cascade' }),
    uploadId: text('upload_id').notNull(),
    objectKey: text('object_key').notNull(),
    size: integer().notNull(),
    expiresAt: integer('expires_at').notNull(),
  },
  (t) => [index('uploads_expiry').on(t.expiresAt), index('uploads_object_key').on(t.objectKey)],
);
export const uploadParts = sqliteTable(
  'upload_parts',
  {
    sessionId: text('session_id')
      .notNull()
      .references(() => uploadSessions.id, { onDelete: 'cascade' }),
    partNumber: integer('part_number').notNull(),
    etag: text().notNull(),
    size: integer().notNull(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.partNumber] })],
);

export const adminAccount = sqliteTable('admin_account', {
  id: integer().primaryKey(),
  passwordHash: text('password_hash').notNull(),
  totpCipher: text('totp_cipher').notNull(),
  lastCounter: integer('last_counter').notNull().default(-1),
  createdAt: integer('created_at').notNull(),
});
export const adminSessions = sqliteTable(
  'admin_sessions',
  { tokenHash: text('token_hash').primaryKey(), expiresAt: integer('expires_at').notNull() },
  (t) => [index('admin_session_expiry').on(t.expiresAt)],
);
export const adminSetup = sqliteTable('admin_setup', {
  tokenHash: text('token_hash').primaryKey(),
  totpCipher: text('totp_cipher').notNull(),
  expiresAt: integer('expires_at').notNull(),
});
export const adminRecovery = sqliteTable('admin_recovery', {
  codeHash: text('code_hash').primaryKey(),
});

export const imageHosts = sqliteTable(
  'image_hosts',
  {
    name: text().primaryKey(),
    fileId: text('file_id')
      .notNull()
      .unique()
      .references(() => files.id, { onDelete: 'cascade' }),
    objectKey: text('object_key').notNull(),
    sha256: text().notNull(),
    enabled: integer().notNull().default(1),
    revokedAt: integer('revoked_at'),
    createdAt: integer('created_at').notNull(),
    views: integer().notNull().default(0),
    downloads: integer().notNull().default(0),
    lastAccessAt: integer('last_access_at'),
  },
  (t) => [index('images_object_key').on(t.objectKey)],
);
