import { describe, expect, it } from 'vitest';
import { app } from '../worker/index';
import { testEnv } from './setup';
import { data, request } from './helpers';

// Read-only metering of an isolated local D1 database. No production bindings.
function meteredDatabase(database: D1Database) {
  const totals = { statements: 0, rowsRead: 0, rowsWritten: 0 };
  const originals = new WeakMap<object, D1PreparedStatement>();
  const record = (result: D1Result) => {
    totals.statements++;
    totals.rowsRead += result.meta.rows_read;
    totals.rowsWritten += result.meta.rows_written;
  };
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const wrapped = {
      bind: (...values: unknown[]) => wrap(statement.bind(...values)),
      all: async () => {
        const result = await statement.all();
        record(result);
        return result;
      },
      run: async () => {
        const result = await statement.run();
        record(result);
        return result;
      },
      first: async (column?: string) => {
        const result = await statement.all<Record<string, unknown>>();
        record(result);
        const row = result.results[0];
        return row ? (column === undefined ? row : row[column]) : null;
      },
      raw: statement.raw.bind(statement),
    } as D1PreparedStatement;
    originals.set(wrapped, statement);
    return wrapped;
  };
  const wrapped = {
    prepare: (sql: string) => wrap(database.prepare(sql)),
    batch: async (statements: D1PreparedStatement[]) => {
      const results = await database.batch(statements.map((s) => originals.get(s) ?? s));
      results.forEach(record);
      return results;
    },
  } as unknown as D1Database;
  return { database: wrapped, totals };
}

describe('WebDAV request resource budgets', () => {
  for (const count of [0, 100, 1000]) {
    it(`meters a warm directory refresh with ${count} files`, async () => {
      const { password } = await data<{ password: string }>(
        await request('/api/admin/webdav', 'POST', { name: 'Local audit only' }),
      );
      await testEnv.DB.prepare('UPDATE webdav_credentials SET last_used_at=?')
        .bind(Date.now())
        .run();
      await testEnv.DB.prepare('UPDATE storage_quota_state SET ready=1 WHERE id=1').run();
      if (count) {
        await testEnv.DB.prepare(
          `WITH RECURSIVE seq(n) AS (
          SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<?)
          INSERT INTO files(id,name,object_key,mime,size,status,created_at,updated_at)
          SELECT 'audit-'||n,'audit-'||n||'.txt','local-audit/'||n,'text/plain',0,'ready',1,1 FROM seq`,
        )
          .bind(count)
          .run();
      }
      const meter = meteredDatabase(testEnv.DB);
      const response = await app.request(
        'http://localhost/dav/',
        {
          method: 'PROPFIND',
          headers: { Authorization: 'Basic ' + btoa('rcloud:' + password), Depth: '1' },
        },
        { ...testEnv, DB: meter.database },
      );
      expect(response.status).toBe(207);
      const xml = await response.text();
      expect(xml.match(/<D:response>/g)).toHaveLength(count + 1);
      expect(meter.totals.rowsWritten).toBe(0);
      expect(meter.totals.statements).toBeLessThanOrEqual(6);
      expect(meter.totals.rowsRead).toBeLessThanOrEqual(count * 3 + 5);
      expect({ files: count, ...meter.totals }).toMatchSnapshot();
      if (count) {
        const fileMeter = meteredDatabase(testEnv.DB);
        const fileResponse = await app.request(
          `http://localhost/dav/audit-${count}.txt`,
          {
            method: 'PROPFIND',
            headers: { Authorization: 'Basic ' + btoa('rcloud:' + password), Depth: '0' },
          },
          { ...testEnv, DB: fileMeter.database },
        );
        expect(fileResponse.status).toBe(207);
        expect((await fileResponse.text()).match(/<D:response>/g)).toHaveLength(1);
        expect(fileMeter.totals.rowsWritten).toBe(0);
        expect(fileMeter.totals.statements).toBeLessThanOrEqual(5);
        // Looking up one path must not scan all of its siblings.
        expect(fileMeter.totals.rowsRead).toBeLessThanOrEqual(12);
        expect({ siblingFiles: count, ...fileMeter.totals }).toMatchSnapshot();
      }
    });
  }
});
