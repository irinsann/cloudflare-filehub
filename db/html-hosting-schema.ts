import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { files, fileShares } from './schema';

export const htmlHosts = sqliteTable(
  'html_hosts',
  {
    fileId: text('file_id')
      .primaryKey()
      .references(() => files.id, { onDelete: 'cascade' }),
    shareId: text('share_id')
      .notNull()
      .unique()
      .references(() => fileShares.id, { onDelete: 'cascade' }),
    version: integer().notNull().default(1),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [index('html_hosts_created').on(sql`${table.createdAt} DESC`, table.fileId)],
);
