import type { AppContext } from './env';
import { now } from './env';
import { fail } from './errors';
import { davPath, resolve, etag, parentPath, type DavNode } from './webdav-store';
import { siteOriginAllowed } from './origins';

export interface DavLock {
  path: string;
  token: string;
  credential_id: string;
  depth: string;
  owner: string;
  expires_at: number;
}
export interface LockState {
  active: DavLock[];
  submitted: Set<string>;
}
export const covers = (lock: DavLock, path: string) =>
  lock.path === path ||
  (lock.depth === 'infinity' && path.startsWith(lock.path.replace(/\/$/, '') + '/'));
export async function locks(c: AppContext) {
  return (
    await c.env.DB.prepare('SELECT * FROM webdav_locks WHERE expires_at>?')
      .bind(now())
      .all<DavLock>()
  ).results;
}
function httpDate(value: string | undefined): number | null {
  if (!value) return null;
  const monthNames = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const modern =
    /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat), (\d{2}) ([A-Z][a-z]{2}) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/.exec(
      value,
    );
  const obsolete =
    /^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday), (\d{2})-([A-Z][a-z]{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) GMT$/.exec(
      value,
    );
  const asctime =
    /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) ([A-Z][a-z]{2}) ( {1}\d|\d{2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(
      value,
    );
  const parts =
    modern ||
    obsolete ||
    (asctime && [
      asctime[0],
      asctime[1],
      asctime[3],
      asctime[2],
      asctime[7],
      asctime[4],
      asctime[5],
      asctime[6],
    ]);
  if (!parts) return null;
  const month = monthNames.indexOf(parts[3]);
  const day = Number(parts[2]),
    hour = Number(parts[5]),
    minute = Number(parts[6]),
    second = Number(parts[7]);
  let year = Number(parts[4]);
  if (month < 0 || day < 1 || hour > 23 || minute > 59 || second > 60) return null;
  if (obsolete) {
    const clock = new Date(now());
    year += Math.floor(clock.getUTCFullYear() / 100) * 100;
    const futureLimit = new Date(clock);
    futureLimit.setUTCFullYear(clock.getUTCFullYear() + 50);
    if (Date.UTC(year, month, day, hour, minute, second) > futureLimit.getTime()) year -= 100;
  }
  const date = new Date(0);
  date.setUTCFullYear(year, month, day);
  date.setUTCHours(hour, minute, Math.min(second, 59), 0);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month ||
    date.getUTCDate() !== day ||
    days[date.getUTCDay()] !== parts[1].slice(0, 3)
  )
    return null;
  return date.getTime() + (second === 60 ? 1000 : 0);
}
export function conditions(c: AppContext, node: DavNode | null) {
  const match = c.req.header('If-Match');
  const none = c.req.header('If-None-Match');
  if (
    match &&
    (!node ||
      !(
        match === '*' ||
        match
          .split(',')
          .map((s) => s.trim())
          .includes(etag(node))
      ))
  )
    fail(412, '文件已改变');
  // HTTP dates have one-second precision. If-Match takes precedence, and malformed
  // or unavailable dates do not turn an unconditional request into a failed write.
  const unmodified = match === undefined ? httpDate(c.req.header('If-Unmodified-Since')) : null;
  if (node && unmodified !== null && Math.floor(node.row.updated_at / 1000) * 1000 > unmodified)
    fail(412, '文件已改变');
  if (
    none &&
    node &&
    (none === '*' ||
      none
        .split(',')
        .map((s) => s.trim().replace(/^W\//, ''))
        .includes(etag(node)))
  )
    return false;
  return true;
}
export async function ifTokens(c: AppContext, requestPath: string, active: DavLock[]) {
  const header = c.req.header('If');
  const submitted = new Set<string>();
  if (!header) return submitted;
  if (header.length > 10000) fail(400, 'If过长');
  let rest = header.trim(),
    resource = requestPath;
  if (!rest) fail(400, 'If条件为空');
  const tagged = rest.startsWith('<');
  const groups = new Map<string, string[]>();
  let count = 0;
  while (rest) {
    if (++count > 80) fail(400, 'If条件过多');
    if (rest.startsWith('<')) {
      if (!tagged) fail(400, 'If不能混合带标签和无标签条件');
      const m = /^<([^>]+)>\s*/.exec(rest);
      if (!m) fail(400, 'If格式无效');
      let url: URL;
      try {
        url = new URL(m[1], c.req.url);
      } catch {
        return fail(400, 'If资源地址无效');
      }
      if (
        (url.origin !== new URL(c.req.url).origin && !siteOriginAllowed(c.env, url.origin)) ||
        url.search ||
        url.hash ||
        url.username ||
        url.password
      )
        fail(412, 'If资源地址无效');
      resource = davPath(url.pathname);
      rest = rest.slice(m[0].length);
    }
    const list = /^\(([^()]*)\)\s*/.exec(rest);
    if (!list) fail(400, 'If条件格式无效');
    groups.set(resource, [...(groups.get(resource) || []), list[1]]);
    if (groups.size > 8) fail(400, 'If资源条件过多');
    rest = rest.slice(list[0].length);
  }
  let passed = false;
  for (const [path, lists] of groups) {
    const node = await resolve(c.env, path);
    for (const list of lists) {
      let expression = list.trim(),
        valid = true,
        terms = 0;
      while (expression) {
        const term = /^(Not\s+)?(?:<([^>]+)>|\[([^\]]+)\])\s*/.exec(expression);
        if (!term) fail(400, 'If条件格式无效');
        terms++;
        const value =
          !!node &&
          (term[2]
            ? active.some((l) => l.token === term[2] && covers(l, node.path))
            : etag(node) === term[3]);
        if (!(term[1] ? !value : value)) valid = false;
        // Submission proves knowledge of a token, independently of the condition's result.
        if (term[2]) submitted.add(term[2]);
        expression = expression.slice(term[0].length);
      }
      if (!terms) fail(400, 'If条件为空');
      if (valid) passed = true;
    }
  }
  if (!passed) fail(412, 'WebDAV条件不满足');
  return submitted;
}
export async function checkLocks(
  c: AppContext,
  path: string,
  options: { descendants?: boolean; membership?: boolean } = {},
  state?: LockState,
) {
  const active = state?.active ?? (await locks(c));
  // Untagged If lists always describe the request URI, even when checking a COPY/MOVE target.
  const submitted =
    state?.submitted ?? (await ifTokens(c, davPath(new URL(c.req.url).pathname), active));
  const affected = active.filter(
    (l) =>
      covers(l, path) ||
      (options.membership && covers(l, parentPath(path))) ||
      (options.descendants && l.path.startsWith(path.replace(/\/$/, '') + '/')),
  );
  if (affected.some((l) => !submitted.has(l.token) || l.credential_id !== c.get('davCredentialId')))
    fail(423, '文件被WebDAV客户端锁定');
  return { active, submitted };
}
