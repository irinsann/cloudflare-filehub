import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { constants, DatabaseSync } from 'node:sqlite';

// Runtime state may change while a site serves traffic. Content, permissions, passwords,
// token configuration, trash, and outstanding upload metadata are not excluded.
const ignoredTables = new Set([
  'd1_migrations',
  'admin_sessions',
  'admin_setup',
  'rate_limits',
  'webdav_locks',
  'storage_write_lease',
  'storage_web_writes',
  'storage_quota_state',
  'cleanup_tasks',
  'operations',
  'google_drive_uploads',
  'google_drive_oauth',
  'google_drive_connections',
  'google_drive_generation',
]);
const ignoredColumns = {
  image_hosts: ['views', 'downloads', 'last_access_at'],
  file_shares: ['views', 'downloads', 'last_access_at'],
  markdown_pages: ['views'],
  site_shares: ['views', 'downloads', 'last_access_at'],
  api_tokens: ['last_used_at'],
  webdav_credentials: ['last_used_at'],
  admin_account: ['last_counter'],
};
const requiredContentTables = [
  'files',
  'folders',
  'image_hosts',
  'file_shares',
  'markdown_pages',
  'markdown_attachments',
  'page_attachments',
  'site_shares',
  'storage_allocations',
];
const quoted = (identifier) => '"' + identifier.replaceAll('"', '""') + '"';
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function cell(value) {
  if (value === null) return ['null'];
  if (typeof value === 'bigint') return ['integer', value.toString()];
  if (typeof value === 'number') return ['real', Object.is(value, -0) ? '-0' : String(value)];
  if (typeof value === 'string') return ['text', value];
  if (value instanceof Uint8Array) return ['blob', Buffer.from(value).toString('base64')];
  throw new Error('Unsupported SQLite value type');
}

/** Load an export into memory only. Neither the input file nor any disk database is opened for writing. */
export function auditSql(sql) {
  const db = new DatabaseSync(':memory:', {
    enableForeignKeyConstraints: false,
    allowExtension: false,
    defensive: true,
  });
  try {
    if (typeof db.setAuthorizer !== 'function')
      throw new Error('Node.js with SQLite authorizer support is required');
    db.exec('PRAGMA temp_store=MEMORY');
    // ATTACH and VACUUM INTO could otherwise write to disk despite the :memory: database.
    // Restrict pragmas too; a SQL backup cannot enable extensions or change output paths.
    db.setAuthorizer((action, arg1, arg2) => {
      if (
        [constants.SQLITE_ATTACH, constants.SQLITE_DETACH, constants.SQLITE_CREATE_VTABLE].includes(
          action,
        )
      )
        return constants.SQLITE_DENY;
      if (
        action === constants.SQLITE_PRAGMA &&
        ![
          'foreign_keys',
          'defer_foreign_keys',
          'recursive_triggers',
          'table_info',
          'quick_check',
        ].includes(String(arg1).toLowerCase())
      )
        return constants.SQLITE_DENY;
      if (
        action === constants.SQLITE_FUNCTION &&
        ['load_extension', 'readfile', 'writefile'].includes(String(arg2).toLowerCase())
      )
        return constants.SQLITE_DENY;
      return constants.SQLITE_OK;
    });
    db.exec(sql);
    // After loading, even accidental writes to the in-memory copy are refused.
    db.setAuthorizer((action, arg1) => {
      if (action === constants.SQLITE_PRAGMA && arg1 === 'table_info') return constants.SQLITE_OK;
      return [constants.SQLITE_READ, constants.SQLITE_SELECT, constants.SQLITE_FUNCTION].includes(
        action,
      )
        ? constants.SQLITE_OK
        : constants.SQLITE_DENY;
    });
    const names = db
      .prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name")
      .all()
      .map((row) => row.name);
    const tables = Object.create(null);
    const excluded = [];
    for (const name of names) {
      if (ignoredTables.has(name) || name.startsWith('sqlite_') || name.startsWith('_cf_')) {
        excluded.push(name);
        continue;
      }
      const ignored = Object.hasOwn(ignoredColumns, name) ? ignoredColumns[name] : [];
      const columns = db
        .prepare(`PRAGMA table_info(${quoted(name)})`)
        .all()
        .map((row) => row.name)
        .filter((column) => !ignored.includes(column))
        .sort();
      if (!columns.length) throw new Error('A protected table has no auditable columns');
      const select = db.prepare(`SELECT ${columns.map(quoted).join(',')} FROM ${quoted(name)}`);
      select.setReadBigInts(true);
      select.setReturnArrays(true);
      // Sorting row digests preserves duplicates and ignores insertion order without retaining
      // plaintext rows. Every value is tagged so NULL, text, numbers, and blobs stay distinct.
      const rows = [];
      for (const row of select.iterate()) rows.push(sha256(JSON.stringify(row.map(cell))));
      rows.sort();
      const hash = createHash('sha256').update(JSON.stringify(columns) + '\n');
      for (const row of rows) hash.update(row + '\n');
      Object.defineProperty(tables, name, {
        enumerable: true,
        value: { count: rows.length, sha256: hash.digest('hex'), columns, ignoredColumns: ignored },
      });
    }
    return {
      version: 1,
      tables,
      ignoredTables: excluded,
      missingRequiredTables: requiredContentTables.filter((name) => !Object.hasOwn(tables, name)),
    };
  } finally {
    db.close();
  }
}

export function auditBackup(path) {
  return auditSql(readFileSync(path, 'utf8'));
}

export function compareReports(before, after) {
  const differences = [];
  const allowedAdditions = [];
  const names = [...new Set([...Object.keys(before.tables), ...Object.keys(after.tables)])].sort();
  for (const table of names) {
    const a = before.tables[table],
      b = after.tables[table];
    // The deployment may add this empty/new feature table. Once it exists in the baseline,
    // its existing rows and configuration are protected just like every other content table.
    if (!a && b && table === 'html_hosts') {
      allowedAdditions.push(table);
      continue;
    }
    if (!a || !b || a.count !== b.count || a.sha256 !== b.sha256) {
      differences.push({
        table,
        reason: !a ? 'table_added' : !b ? 'table_removed' : 'content_changed',
        before: a ? { count: a.count, sha256: a.sha256 } : null,
        after: b ? { count: b.count, sha256: b.sha256 } : null,
      });
    }
  }
  return { equal: differences.length === 0, differences, allowedAdditions };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const paths = process.argv.slice(2);
  if (paths.length < 1 || paths.length > 2 || paths.some((path) => path.startsWith('--'))) {
    console.error('Usage: node scripts/audit-backup.mjs before.sql [after.sql]');
    process.exitCode = 2;
  } else {
    let stage = 'before';
    try {
      const before = auditBackup(paths[0]);
      if (before.missingRequiredTables.length)
        throw new Error('Required content tables are missing');
      if (paths.length === 1) console.log(JSON.stringify({ mode: 'report', ...before }, null, 2));
      else {
        stage = 'after';
        const after = auditBackup(paths[1]);
        if (after.missingRequiredTables.length)
          throw new Error('Required content tables are missing');
        const comparison = compareReports(before, after);
        console.log(JSON.stringify({ mode: 'compare', ...comparison, before, after }, null, 2));
        if (!comparison.equal) process.exitCode = 1;
      }
    } catch (error) {
      // SQLite diagnostics can contain SQL or user values: never print their message/stack.
      console.error(
        JSON.stringify({
          error: 'Backup audit could not be completed',
          stage,
          code: /^ERR_[A-Z_]+$/.test(error?.code || '') ? error.code : 'AUDIT_FAILED',
        }),
      );
      process.exitCode = 2;
    }
  }
}
