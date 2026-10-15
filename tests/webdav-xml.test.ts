import { describe, expect, it } from 'vitest';
import { parseLock, parsePropfind, parseProppatch, XmlParseError } from '../worker/webdav-xml';

const find = (body: string) => `<d:propfind xmlns:d="DAV:">${body}</d:propfind>`;
const update = (body: string) =>
  `<d:propertyupdate xmlns:d="DAV:" xmlns:x="urn:test">${body}</d:propertyupdate>`;
const lock = (owner = '', scope = '<d:exclusive/>') =>
  `<d:lockinfo xmlns:d="DAV:"><d:lockscope>${scope}</d:lockscope><d:locktype><d:write/></d:locktype>${owner}</d:lockinfo>`;

describe('WebDAV property XML', () => {
  it('accepts empty bodies, arbitrary DAV prefixes, default namespaces and all three query modes', () => {
    expect(parsePropfind(' \n')).toEqual({ mode: 'allprop', properties: [] });
    expect(
      parsePropfind('<?xml version="1.0"?><propfind xmlns="DAV:"><allprop/></propfind>'),
    ).toEqual({ mode: 'allprop', properties: [] });
    expect(parsePropfind(find('<d:propname/>'))).toEqual({ mode: 'propname', properties: [] });
    expect(
      parsePropfind(find('<d:prop><d:displayname/><z:custom xmlns:z="urn:custom"/></d:prop>')),
    ).toEqual({
      mode: 'prop',
      properties: [
        { namespace: 'DAV:', name: 'displayname' },
        { namespace: 'urn:custom', name: 'custom' },
      ],
    });
  });

  it('resolves names by URI, deduplicates aliases, and retains same local names in different namespaces', () => {
    expect(
      parsePropfind(
        find('<d:prop><d:name/><z:name xmlns:z="DAV:"/><d:name xmlns:d="urn:other"/></d:prop>'),
      ).properties,
    ).toEqual([
      { namespace: 'DAV:', name: 'name' },
      { namespace: 'urn:other', name: 'name' },
    ]);
    expect(() =>
      parsePropfind('<d:propfind xmlns:d="urn:wrong"><d:allprop/></d:propfind>'),
    ).toThrow(XmlParseError);
    expect(() => parsePropfind(find('<d:allprop xmlns:d="urn:wrong"/>'))).toThrow(XmlParseError);
  });

  it('supports allprop include while rejecting mixed selectors and property values in PROPFIND', () => {
    expect(
      parsePropfind(find('<d:allprop/><d:include><x:extra xmlns:x="urn:x"/></d:include>')),
    ).toEqual({ mode: 'allprop', properties: [{ namespace: 'urn:x', name: 'extra' }] });
    for (const body of [
      '',
      '<d:allprop/><d:propname/>',
      '<d:include/><d:allprop/>',
      '<d:prop><d:name>value</d:name></d:prop>',
      '<d:prop>bad<d:name/></d:prop>',
    ]) {
      expect(() => parsePropfind(find(body))).toThrow(XmlParseError);
    }
  });

  it('preserves ordered set/remove operations and plain strings, including entities, CDATA and whitespace', () => {
    const result = parseProppatch(
      update(
        '<d:set><d:prop><x:title> A &amp; B <![CDATA[<C>]]> &#x4e2d; </x:title><x:empty/></d:prop></d:set><d:remove><d:prop><x:title/></d:prop></d:remove><d:set><d:prop><x:title>final</x:title></d:prop></d:set>',
      ),
    );
    expect(result).toEqual([
      {
        action: 'set',
        property: { namespace: 'urn:test', name: 'title' },
        value: ' A & B <C> 中 ',
      },
      { action: 'set', property: { namespace: 'urn:test', name: 'empty' }, value: '' },
      { action: 'remove', property: { namespace: 'urn:test', name: 'title' } },
      { action: 'set', property: { namespace: 'urn:test', name: 'title' }, value: 'final' },
    ]);
  });

  it('rejects nested or attributed dead values instead of silently losing XML information', () => {
    for (const body of [
      '<d:set><d:prop><x:value><x:child/></x:value></d:prop></d:set>',
      '<d:set><d:prop><x:value xml:lang="zh">你好</x:value></d:prop></d:set>',
      '<d:remove><d:prop><x:value>not empty</x:value></d:prop></d:remove>',
      '<d:set><d:prop/><d:prop/></d:set>',
      '<d:set><x:prop><x:value>bad namespace</x:value></x:prop></d:set>',
      '<x:set><d:prop><x:value>bad namespace</x:value></d:prop></x:set>',
      '',
    ])
      expect(() => parseProppatch(update(body))).toThrow(XmlParseError);
  });
});

describe('WebDAV LOCK XML', () => {
  it('accepts exclusive write locks with absent, plain-text and DAV href owners', () => {
    expect(parseLock(lock())).toEqual({
      scope: 'exclusive',
      type: 'write',
      owner: null,
      ownerHref: false,
    });
    expect(parseLock(lock('<d:owner> RaiDrive &amp; Windows </d:owner>'))).toEqual({
      scope: 'exclusive',
      type: 'write',
      owner: ' RaiDrive & Windows ',
      ownerHref: false,
    });
    expect(
      parseLock(lock('<d:owner>\n<d:href>mailto:test@example.com</d:href>\n</d:owner>')),
    ).toEqual({
      scope: 'exclusive',
      type: 'write',
      owner: 'mailto:test@example.com',
      ownerHref: true,
    });
    expect(parseLock(lock('<d:owner/>')).owner).toBe('');
  });

  it('rejects ambiguous scopes/types, wrong namespaces, malformed owners and shared locks', () => {
    for (const source of [
      lock('', '<d:shared/>'),
      lock('', '<d:exclusive/><d:shared/>'),
      lock('', '<d:exclusive xmlns:d="urn:wrong"/>'),
      lock('<d:owner/><d:owner/>'),
      lock('<d:owner><d:href>a</d:href><d:href>b</d:href></d:owner>'),
      lock('<d:owner>mixed<d:href>a</d:href></d:owner>'),
      lock('<d:owner><x:href xmlns:x="urn:wrong">a</x:href></d:owner>'),
      lock().replace('<d:write/>', '<d:read/>'),
      '<d:lockinfo xmlns:d="DAV:"><d:locktype><d:write/></d:locktype></d:lockinfo>',
    ])
      expect(() => parseLock(source)).toThrow(XmlParseError);
  });
});

describe('bounded XML parsing', () => {
  it('rejects DTD/entity declarations and undeclared entities, with no entity expansion', () => {
    for (const source of [
      '<!DOCTYPE d:propfind SYSTEM "https://example.invalid/external.dtd">' + find('<d:allprop/>'),
      '<!DOCTYPE d:propfind [<!ENTITY leak SYSTEM "file:///secret">]>' +
        find('<d:prop>&leak;</d:prop>'),
      '<!DOCTYPE d:propfind [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;&a;">]>' +
        find('<d:prop>&b;</d:prop>'),
      find('<d:prop>&unknown;</d:prop>'),
    ])
      expect(() => parsePropfind(source)).toThrow(XmlParseError);
  });

  it('fails closed for malformed XML, namespace errors and invalid XML 1.0 characters', () => {
    for (const source of [
      find('<d:allprop>'),
      find('<d:allprop/>') + find('<d:allprop/>'),
      '<d:propfind><d:allprop/></d:propfind>',
      '<d:propfind xmlns:d="DAV:" xmlns:d="DAV:"><d:allprop/></d:propfind>',
      find('<d:prop>&#0;</d:prop>'),
      '<?xml version="1.1"?>' + find('<d:allprop/>'),
    ])
      expect(() => parsePropfind(source)).toThrow(XmlParseError);
  });

  it('enforces the UTF-8 byte bound before parsing, including whitespace-only requests', () => {
    const prefix = '<d:propertyupdate xmlns:d="DAV:"><d:set><d:prop><v>';
    const suffix = '</v></d:prop></d:set></d:propertyupdate>';
    const size = new TextEncoder().encode(prefix + suffix).length;
    const atLimit = prefix + 'a'.repeat(65536 - size) + suffix;
    expect(parseProppatch(atLimit)).toHaveLength(1);
    expect(() => parseProppatch(atLimit + ' ')).toThrow('64 KiB');
    expect(() => parseProppatch(prefix + '界'.repeat(22000) + suffix)).toThrow('64 KiB');
    expect(() => parsePropfind(' '.repeat(65537))).toThrow('64 KiB');
  });

  it('bounds total nodes and nesting rather than allowing unbounded parser structures', () => {
    expect(
      parsePropfind(find('<d:prop>' + '<p/>'.repeat(997) + '</d:prop>')).properties,
    ).toHaveLength(1);
    expect(() => parsePropfind(find('<d:prop>' + '<p/>'.repeat(998) + '</d:prop>'))).toThrow(
      '1000',
    );
    expect(() =>
      parseLock(lock('<d:owner>' + '<p>'.repeat(31) + '</p>'.repeat(31) + '</d:owner>')),
    ).toThrow('32 层');
  });
});
