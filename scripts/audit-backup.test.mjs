import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { auditSql, compareReports } from './audit-backup.mjs';

const schema = [
  'files',
  'folders',
  'image_hosts',
  'file_shares',
  'markdown_pages',
  'markdown_attachments',
  'page_attachments',
  'site_shares',
  'storage_allocations',
]
  .map(
    (table) =>
      `CREATE TABLE ${table}(id TEXT,value BLOB,views INTEGER,downloads INTEGER,last_access_at INTEGER);`,
  )
  .join('\n');
const records =
  "INSERT INTO files VALUES('one','PRIVATE CONTENT',1,2,3); INSERT INTO files VALUES('two',9223372036854775807,0,0,0); INSERT INTO image_hosts VALUES('image','protected object',1,2,3);";
const before = schema + records;

test('canonical hashes ignore row order and preserve all data types and duplicates', () => {
  const reordered =
    schema +
    "INSERT INTO files VALUES('two',9223372036854775807,0,0,0); INSERT INTO files VALUES('one','PRIVATE CONTENT',1,2,3); INSERT INTO image_hosts VALUES('image','protected object',1,2,3);";
  assert.equal(compareReports(auditSql(before), auditSql(reordered)).equal, true);
  for (const change of [
    "UPDATE files SET value='changed' WHERE id='one';",
    "UPDATE files SET value='9223372036854775807' WHERE id='two';",
    "DELETE FROM files WHERE id='one';",
    "INSERT INTO files SELECT * FROM files WHERE id='one';",
  ])
    assert.equal(compareReports(auditSql(before), auditSql(before + change)).equal, false);
});

test('ignores only declared natural counters and protects sharing configuration', () => {
  const traffic = before + 'UPDATE image_hosts SET views=999,downloads=888,last_access_at=777;';
  assert.equal(compareReports(auditSql(before), auditSql(traffic)).equal, true);
  assert.equal(
    compareReports(
      auditSql(before),
      auditSql(before + "UPDATE image_hosts SET value='different object';"),
    ).equal,
    false,
  );
  assert.equal(
    compareReports(auditSql(before), auditSql(before + 'UPDATE files SET views=9;')).equal,
    false,
  );
});

test('allows newly added html_hosts but protects it once present in the baseline', () => {
  const hosted =
    before +
    "CREATE TABLE html_hosts(file_id TEXT,share_id TEXT); INSERT INTO html_hosts VALUES('one','share');";
  assert.deepEqual(compareReports(auditSql(before), auditSql(hosted)).allowedAdditions, [
    'html_hosts',
  ]);
  assert.equal(compareReports(auditSql(before), auditSql(hosted)).equal, true);
  assert.equal(
    compareReports(auditSql(hosted), auditSql(hosted + "UPDATE html_hosts SET share_id='changed';"))
      .equal,
    false,
  );
  assert.equal(compareReports(auditSql(hosted), auditSql(before)).equal, false);
  assert.equal(
    compareReports(auditSql(before), auditSql(before + 'CREATE TABLE unexpected(id TEXT);')).equal,
    false,
  );
});

test('preserves tables whose names match JavaScript prototype properties', () => {
  const source = before + 'CREATE TABLE constructor(id TEXT); CREATE TABLE __proto__(id TEXT);';
  const report = auditSql(source);
  assert.equal(Object.hasOwn(report.tables, 'constructor'), true);
  assert.equal(Object.hasOwn(report.tables, '__proto__'), true);
  assert.equal(
    compareReports(report, auditSql(source + "INSERT INTO __proto__ VALUES('change');")).equal,
    false,
  );
});

test('CLI is read-only, detects differences, and never prints SQL, record values, or diagnostics', () => {
  const directory = mkdtempSync(join(tmpdir(), 'rcloud-backup-audit-'));
  const a = join(directory, 'before.sql'),
    b = join(directory, 'after.sql'),
    outside = join(directory, 'forbidden.sqlite');
  const script = fileURLToPath(new URL('./audit-backup.mjs', import.meta.url));
  const run = (...paths) => spawnSync(process.execPath, [script, ...paths], { encoding: 'utf8' });
  try {
    writeFileSync(a, before);
    writeFileSync(b, before + "UPDATE files SET value='private changed content' WHERE id='one';");
    assert.equal(run(a, a).status, 0);
    const changed = run(a, b);
    assert.equal(changed.status, 1);
    const report = JSON.parse(changed.stdout);
    assert.equal(report.equal, false);
    assert.deepEqual(
      report.differences.map((difference) => difference.table),
      ['files'],
    );
    assert.doesNotMatch(changed.stdout + changed.stderr, /PRIVATE CONTENT|private changed content/);
    assert.equal(readFileSync(a, 'utf8'), before);
    for (const forbidden of [
      `ATTACH DATABASE '${outside.replaceAll("'", "''")}' AS outside;`,
      `VACUUM INTO '${outside.replaceAll("'", "''")}';`,
      "SELECT load_extension('PRIVATE CONTENT');",
      'PRAGMA writable_schema=ON;',
      "SELECT missing_function('PRIVATE CONTENT');",
    ]) {
      writeFileSync(b, forbidden);
      const denied = run(a, b);
      assert.equal(denied.status, 2);
      assert.doesNotMatch(denied.stdout + denied.stderr, /PRIVATE CONTENT|missing_function/);
      assert.equal(existsSync(outside), false);
    }
    writeFileSync(b, '');
    assert.equal(run(b, b).status, 2);
  } finally {
    for (const file of [a, b]) if (existsSync(file)) unlinkSync(file);
    // Only remove this empty directory created by the test; no recursive removal is used.
    rmdirSync(directory);
  }
});
