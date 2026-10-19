import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { folders } from './schema';

export const siteShares = sqliteTable(
  'site_shares',
  {
    id: text().primaryKey(),
    folderId: text('folder_id')
      .notNull()
      .references(() => folders.id, { onDelete: 'cascade' }),
    tokenSeed: text('token_seed').notNull(),
    passwordHash: text('password_hash'),
    grantVersion: integer('grant_version').notNull().default(1),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at'),
    enabled: integer().notNull().default(1),
    views: integer().notNull().default(0),
    lastAccessAt: integer('last_access_at'),
  },
  (table) => [
    index('site_shares_folder').on(table.folderId),
    index('site_shares_created').on(table.createdAt, table.id),
  ],
);
