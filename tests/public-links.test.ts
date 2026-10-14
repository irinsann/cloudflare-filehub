import { describe, expect, it } from 'vitest';
import {
  normalizePublicOrigin,
  preferredPublicOrigin,
  publicLinkOptions,
  rewritePublicLink,
} from '../src/lib/public-links';
import { app } from '../worker/index';
import { data, request, upload, createMarkdown } from './helpers';
import { testEnv } from './setup';
import type { FileRecord } from '../shared/types';

const globalOrigin = 'https://233334.xyz';
const hongKongOrigin = 'https://s.irin.im';
const configured = {
  adminOrigin: globalOrigin,
  markdownOrigin: globalOrigin,
  filesOrigin: hongKongOrigin,
};
const trusted = [globalOrigin, hongKongOrigin];

describe('公开链接域名选择', () => {
  it('accepts complete HTTP origins and canonicalizes host, default port and trailing slash', () => {
    expect(normalizePublicOrigin('HTTPS://233334.XYZ:443/')).toBe(globalOrigin);
    expect(normalizePublicOrigin('http://localhost:8787/')).toBe('http://localhost:8787');
    expect(normalizePublicOrigin('https://cdn.example.test:8443')).toBe(
      'https://cdn.example.test:8443',
    );
  });

  it('rejects non-origins, credentials and non-HTTP schemes', () => {
    for (const value of [
      undefined,
      null,
      1,
      {},
      '',
      '233334.xyz',
      '//233334.xyz',
      'javascript:alert(1)',
      'data:text/html,test',
      'blob:https://233334.xyz/id',
      'ftp://233334.xyz',
      'https://owner:secret@233334.xyz',
      'https://owner@233334.xyz',
      'https://233334.xyz/drive/',
      'https://233334.xyz?next=evil',
      'https://233334.xyz#anchor',
    ])
      expect(normalizePublicOrigin(value)).toBeNull();
  });

  it('builds distinct global and Hong Kong choices from configuration, without fixed deployment domains', () => {
    expect(
      publicLinkOptions(configured, hongKongOrigin).map(({ origin, kind }) => ({ origin, kind })),
    ).toEqual([
      { origin: globalOrigin, kind: 'global' },
      { origin: hongKongOrigin, kind: 'hong-kong' },
    ]);
    const custom = publicLinkOptions(
      { adminOrigin: 'https://drive.example.test', filesOrigin: 'https://files.example.test' },
      globalOrigin,
    );
    expect(custom.map((option) => option.origin)).toEqual([
      'https://drive.example.test',
      'https://files.example.test',
    ]);
    expect(custom.map((option) => option.host)).toEqual([
      'drive.example.test',
      'files.example.test',
    ]);
    expect(custom.every((option) => option.label.length > 0)).toBe(true);
  });

  it('deduplicates origins and falls back through Markdown origin to the current site safely', () => {
    expect(
      publicLinkOptions(
        { adminOrigin: 'https://233334.xyz/', filesOrigin: 'https://233334.xyz:443' },
        hongKongOrigin,
      ).map(({ origin, kind }) => ({ origin, kind })),
    ).toEqual([{ origin: globalOrigin, kind: 'global' }]);
    expect(
      publicLinkOptions(
        { adminOrigin: 'javascript:alert(1)', markdownOrigin: globalOrigin },
        hongKongOrigin,
      )[0].origin,
    ).toBe(globalOrigin);
    expect(
      publicLinkOptions(
        { adminOrigin: 'https://user@evil.test', markdownOrigin: 'https://invalid.test/path' },
        'http://localhost:8787',
      )[0].origin,
    ).toBe('http://localhost:8787');
    expect(publicLinkOptions(null, globalOrigin).map((option) => option.origin)).toEqual([
      globalOrigin,
    ]);
    expect(publicLinkOptions({ filesOrigin: 'data:text/plain,test' }, 'invalid')).toEqual([]);
  });

  it('only restores a saved preference that is still an available origin', () => {
    const options = publicLinkOptions(configured, globalOrigin);
    expect(preferredPublicOrigin(options, globalOrigin)).toBe(globalOrigin);
    expect(preferredPublicOrigin(options, hongKongOrigin)).toBe(hongKongOrigin);
    for (const saved of [
      undefined,
      null,
      {},
      'https://removed.example.test',
      'javascript:alert(1)',
      'https://user@s.irin.im',
    ]) {
      expect(preferredPublicOrigin(options, saved)).toBe(hongKongOrigin);
    }
    expect(preferredPublicOrigin(publicLinkOptions(null, globalOrigin), hongKongOrigin)).toBe(
      globalOrigin,
    );
    expect(preferredPublicOrigin([], globalOrigin)).toBe('');
  });

  it('preserves encoded paths, query order, repeated values and fragments when switching either way', () => {
    const suffix = '/i/%E7%85%A7%E7%89%87%2Fname.png?download=1&x=a+b&x=%2f%26#section%20one';
    const globalLink = rewritePublicLink(hongKongOrigin + suffix, globalOrigin, trusted);
    expect(globalLink).toBe(globalOrigin + suffix);
    expect(rewritePublicLink(globalLink, hongKongOrigin, trusted)).toBe(hongKongOrigin + suffix);
    expect(rewritePublicLink('HTTPS://S.IRIN.IM:443' + suffix, globalOrigin, trusted)).toBe(
      globalOrigin + suffix,
    );
    for (const ending of ['?', '#', '?#']) {
      expect(rewritePublicLink(hongKongOrigin + '/p/article' + ending, globalOrigin, trusted)).toBe(
        globalOrigin + '/p/article' + ending,
      );
    }
  });

  it('leaves external URLs, lookalike hosts, credentials, relative links and unsafe schemes untouched', () => {
    for (const url of [
      'https://external.example/i/picture.png?x=1#part',
      'https://s.irin.im.evil.test/i/picture.png',
      'https://s.irin.im@evil.test/i/picture.png',
      'https://owner:secret@s.irin.im/i/picture.png',
      'https://sub.s.irin.im/i/picture.png',
      'javascript:alert(1)',
      'data:image/png;base64,abc',
      'blob:https://s.irin.im/id',
      '/i/picture.png',
      '//s.irin.im/i/picture.png',
      '../i/picture.png',
      '#section',
      'not a URL',
    ])
      expect(rewritePublicLink(url, globalOrigin, trusted)).toBe(url);
  });

  it('refuses invalid or untrusted targets even if supplied as a saved value', () => {
    const source = hongKongOrigin + '/p/article?source=share#chapter';
    for (const target of [
      '',
      'https://evil.test',
      'javascript:alert(1)',
      globalOrigin + '/drive',
      'https://user@233334.xyz',
    ]) {
      expect(rewritePublicLink(source, target, trusted)).toBe(source);
    }
    expect(rewritePublicLink(source, globalOrigin, [globalOrigin])).toBe(source);
    expect(
      rewritePublicLink(source, 'javascript:alert(1)', [...trusted, 'javascript:alert(1)']),
    ).toBe(source);
  });
});

const png = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a33sAAAAASUVORK5CYII=',
  ),
  (character) => character.charCodeAt(0),
);
const publicEnv = {
  ...testEnv,
  ENVIRONMENT: 'production',
  LOCAL_AUTH: 'false',
  AUTH_MODE: 'password_totp',
  ADMIN_ORIGIN: globalOrigin,
  MARKDOWN_ORIGIN: globalOrigin,
  FILES_ORIGIN: hongKongOrigin,
  TRUSTED_PROXY_ORIGINS: hongKongOrigin,
};

describe('所选公开域名与 Worker 路由', () => {
  it('serves the same share, direct download, image and article through both selected origins', async () => {
    const file = await data<FileRecord>(await upload('shared.txt', 'same shared bytes'));
    const share = await data<{ url: string; directUrl: string }>(
      await request(
        '/api/admin/shares',
        'POST',
        { file_id: file.id },
        { ...testEnv, FILES_ORIGIN: hongKongOrigin },
      ),
    );
    const imageFile = await data<FileRecord>(await upload('image.png', png));
    const image = await data<{ url: string }>(
      await request(
        '/api/admin/images',
        'POST',
        { file_id: imageFile.id },
        { ...testEnv, FILES_ORIGIN: hongKongOrigin },
      ),
    );
    const document = await createMarkdown('# Same article', 'links.md');
    await data(
      await request(`/api/admin/markdown/${document.id}/publish`, 'POST', {
        title: 'Same article',
        slug: 'selected-origin',
        version: document.version,
      }),
    );
    const article = `${globalOrigin}/p/selected-origin`;
    for (const option of publicLinkOptions(configured, globalOrigin)) {
      const rewritten = (url: string) => rewritePublicLink(url, option.origin, trusted);
      const sharePage = await app.request(rewritten(share.url), {}, publicEnv);
      expect(sharePage.status).toBe(200);
      expect(sharePage.headers.get('Content-Type')).toContain('text/html');
      const download = await app.request(rewritten(share.directUrl), {}, publicEnv);
      expect(download.status).toBe(200);
      expect(await download.text()).toBe('same shared bytes');
      const hostedImage = await app.request(rewritten(image.url), {}, publicEnv);
      expect(hostedImage.status).toBe(200);
      expect(new Uint8Array(await hostedImage.arrayBuffer())).toEqual(png);
      const imageDownload = await app.request(rewritten(image.url + '?download=1'), {}, publicEnv);
      expect(imageDownload.headers.get('Content-Disposition')).toMatch(/^attachment/);
      const page = await app.request(rewritten(article + '#same-article'), {}, publicEnv);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('Same article');
      expect((await app.request(option.origin + '/api/admin/settings', {}, publicEnv)).status).toBe(
        401,
      );
    }
  });

  it('keeps revoked links and unpublished articles inaccessible on both origins', async () => {
    const file = await data<FileRecord>(await upload('revoked.txt', 'private'));
    const share = await data<{ id: string; url: string; directUrl: string }>(
      await request(
        '/api/admin/shares',
        'POST',
        { file_id: file.id },
        { ...testEnv, FILES_ORIGIN: hongKongOrigin },
      ),
    );
    const imageFile = await data<FileRecord>(await upload('revoked.png', png));
    const image = await data<{ name: string; url: string }>(
      await request(
        '/api/admin/images',
        'POST',
        { file_id: imageFile.id },
        { ...testEnv, FILES_ORIGIN: hongKongOrigin },
      ),
    );
    const document = await createMarkdown('# Private article', 'private.md');
    await data(
      await request(`/api/admin/markdown/${document.id}/publish`, 'POST', {
        title: 'Private article',
        slug: 'private-origin',
        version: document.version,
      }),
    );
    await request('/api/admin/shares/' + share.id, 'DELETE');
    await request('/api/admin/images/' + image.name, 'DELETE');
    await request(`/api/admin/markdown/${document.id}/unpublish`, 'POST');
    for (const origin of trusted) {
      expect(
        (await app.request(rewritePublicLink(share.url, origin, trusted), {}, publicEnv)).status,
      ).toBe(410);
      expect(
        (await app.request(rewritePublicLink(share.directUrl, origin, trusted), {}, publicEnv))
          .status,
      ).toBe(410);
      expect(
        (await app.request(rewritePublicLink(image.url, origin, trusted), {}, publicEnv)).status,
      ).toBe(404);
      expect((await app.request(origin + '/p/private-origin', {}, publicEnv)).status).toBe(404);
    }
  });
});
