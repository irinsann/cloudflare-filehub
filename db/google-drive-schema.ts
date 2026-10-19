import { sqliteTable, integer, text, index } from 'drizzle-orm/sqlite-core';
export const googleDriveGeneration = sqliteTable('google_drive_generation', {
  id: integer().primaryKey(),
  generation: integer().notNull().default(0),
});
export const googleDriveConnections = sqliteTable('google_drive_connections', {
  id: integer().primaryKey(),
  connectionId: text('connection_id').notNull().unique(),
  accountJson: text('account_json').notNull(),
  refreshCipher: text('refresh_cipher').notNull(),
  accessCipher: text('access_cipher').notNull(),
  accessExpires: integer('access_expires').notNull(),
  refreshOwner: text('refresh_owner'),
  refreshUntil: integer('refresh_until').notNull().default(0),
  createdAt: integer('created_at').notNull(),
});
export const googleDriveOauth = sqliteTable(
  'google_drive_oauth',
  {
    stateHash: text('state_hash').primaryKey(),
    nonceHash: text('nonce_hash').notNull(),
    verifierCipher: text('verifier_cipher').notNull(),
    origin: text().notNull(),
    adminSessionHash: text('admin_session_hash'),
    generation: integer().notNull(),
    expiresAt: integer('expires_at').notNull(),
  },
  (t) => [index('google_drive_oauth_expiry').on(t.expiresAt)],
);
export const googleDriveUploads = sqliteTable(
  'google_drive_uploads',
  {
    id: text().primaryKey(),
    connectionId: text('connection_id')
      .notNull()
      .references(() => googleDriveConnections.connectionId, { onDelete: 'cascade' }),
    sessionCipher: text('session_cipher').notNull(),
    fileId: text('file_id').notNull(),
    size: integer().notNull(),
    offset: integer().notNull().default(0),
    resultJson: text('result_json'),
    expiresAt: integer('expires_at').notNull(),
    owner: text(),
    lockUntil: integer('lock_until').notNull().default(0),
    cancelled: integer().notNull().default(0),
  },
  (t) => [index('google_drive_upload_expiry').on(t.expiresAt)],
);
