import { SaxesParser } from 'saxes';

const davNamespace = 'DAV:';
const xmlnsNamespace = 'http://www.w3.org/2000/xmlns/';
const maxBytes = 64 * 1024;

export class XmlParseError extends Error {
  constructor(message = 'XML 格式无效') {
    super(message);
    this.name = 'XmlParseError';
  }
}

export interface DavPropertyName {
  namespace: string;
  name: string;
}
export interface PropfindRequest {
  mode: 'allprop' | 'propname' | 'prop';
  properties: DavPropertyName[];
}
export type PropertyUpdate =
  | { action: 'set'; property: DavPropertyName; value: string }
  | { action: 'remove'; property: DavPropertyName };
export interface LockRequest {
  scope: 'exclusive';
  type: 'write';
  owner: string | null;
  ownerHref: boolean;
}

interface XmlNode extends DavPropertyName {
  children: (XmlNode | string)[];
  hasAttributes: boolean;
}

function checkSize(source: string) {
  if (new TextEncoder().encode(source).byteLength > maxBytes)
    throw new XmlParseError('XML 请求不能超过 64 KiB');
}

function parseDocument(source: string): XmlNode {
  checkSize(source);
  const parser = new SaxesParser({ xmlns: true });
  const stack: XmlNode[] = [];
  let root: XmlNode | null = null;
  let nodes = 0;
  const count = () => {
    if (++nodes > 1000) throw new XmlParseError('XML 节点数不能超过 1000');
  };
  const text = (value: string) => {
    if (!value) return;
    count();
    stack.at(-1)?.children.push(value);
  };
  parser.on('error', () => {
    throw new XmlParseError();
  });
  parser.on('doctype', () => {
    throw new XmlParseError('不允许 XML DOCTYPE 或自定义实体');
  });
  parser.on('xmldecl', (declaration) => {
    if (declaration.version !== '1.0') throw new XmlParseError('仅支持 XML 1.0');
  });
  parser.on('attribute', count);
  parser.on('comment', count);
  parser.on('processinginstruction', count);
  parser.on('text', text);
  parser.on('cdata', text);
  parser.on('opentag', (tag) => {
    count();
    if (stack.length >= 32) throw new XmlParseError('XML 嵌套不能超过 32 层');
    const node: XmlNode = {
      namespace: tag.uri,
      name: tag.local,
      children: [],
      hasAttributes: Object.values(tag.attributes).some(
        (attribute) => attribute.uri !== xmlnsNamespace,
      ),
    };
    if (stack.length) stack.at(-1)!.children.push(node);
    else {
      if (root) throw new XmlParseError();
      root = node;
    }
    stack.push(node);
  });
  parser.on('closetag', () => {
    stack.pop();
  });
  try {
    parser.write(source).close();
  } catch (error) {
    if (error instanceof XmlParseError) throw error;
    throw new XmlParseError();
  }
  if (!root || stack.length) throw new XmlParseError();
  return root;
}

function isDav(node: XmlNode, name: string) {
  return node.namespace === davNamespace && node.name === name;
}
function requireDav(node: XmlNode, name: string) {
  if (!isDav(node, name)) throw new XmlParseError('WebDAV XML 元素无效');
}
function childElements(node: XmlNode) {
  if (node.children.some((child) => typeof child === 'string' && child.trim()))
    throw new XmlParseError('WebDAV XML 结构不能包含文本');
  return node.children.filter((child): child is XmlNode => typeof child !== 'string');
}
function requireEmpty(node: XmlNode) {
  if (childElements(node).length) throw new XmlParseError('此 XML 元素必须为空');
}
function propertyName(node: XmlNode): DavPropertyName {
  return { namespace: node.namespace, name: node.name };
}
function plainText(node: XmlNode) {
  if (node.hasAttributes || node.children.some((child) => typeof child !== 'string'))
    throw new XmlParseError('属性值仅支持纯文本');
  return node.children.join('');
}
function requestedProperties(node: XmlNode) {
  const names = new Map<string, DavPropertyName>();
  for (const child of childElements(node)) {
    requireEmpty(child);
    const property = propertyName(child);
    names.set(JSON.stringify([property.namespace, property.name]), property);
  }
  return [...names.values()];
}

export function parsePropfind(source: string): PropfindRequest {
  checkSize(source);
  if (!source.trim()) return { mode: 'allprop', properties: [] };
  const root = parseDocument(source);
  requireDav(root, 'propfind');
  const children = childElements(root);
  const selector = children[0];
  if (!selector) throw new XmlParseError('缺少 PROPFIND 查询类型');
  if (isDav(selector, 'allprop')) {
    requireEmpty(selector);
    if (children.length > 2 || (children[1] && !isDav(children[1], 'include')))
      throw new XmlParseError('PROPFIND 查询类型重复或无效');
    return { mode: 'allprop', properties: children[1] ? requestedProperties(children[1]) : [] };
  }
  if (children.length !== 1) throw new XmlParseError('PROPFIND 查询类型重复或无效');
  if (isDav(selector, 'propname')) {
    requireEmpty(selector);
    return { mode: 'propname', properties: [] };
  }
  requireDav(selector, 'prop');
  return { mode: 'prop', properties: requestedProperties(selector) };
}

export function parseProppatch(source: string): PropertyUpdate[] {
  const root = parseDocument(source);
  requireDav(root, 'propertyupdate');
  const result: PropertyUpdate[] = [];
  for (const operation of childElements(root)) {
    const action = isDav(operation, 'set') ? 'set' : isDav(operation, 'remove') ? 'remove' : null;
    if (!action) throw new XmlParseError('PROPPATCH 操作无效');
    const children = childElements(operation);
    if (children.length !== 1) throw new XmlParseError('每个属性操作必须包含一个 prop');
    requireDav(children[0], 'prop');
    for (const node of childElements(children[0])) {
      const property = propertyName(node);
      if (action === 'set') result.push({ action, property, value: plainText(node) });
      else {
        requireEmpty(node);
        result.push({ action, property });
      }
    }
  }
  if (!result.length) throw new XmlParseError('未指定要修改的属性');
  return result;
}

export function parseLock(source: string): LockRequest {
  const root = parseDocument(source);
  requireDav(root, 'lockinfo');
  const children = childElements(root);
  if (
    children.some(
      (child) =>
        child.namespace !== davNamespace ||
        !['lockscope', 'locktype', 'owner'].includes(child.name),
    )
  )
    throw new XmlParseError('LOCK XML 元素无效');
  const scopes = children.filter((child) => isDav(child, 'lockscope'));
  const types = children.filter((child) => isDav(child, 'locktype'));
  const owners = children.filter((child) => isDav(child, 'owner'));
  if (scopes.length !== 1 || types.length !== 1 || owners.length > 1)
    throw new XmlParseError('LOCK 类型缺失或重复');
  for (const [node, type] of [
    [scopes[0], 'exclusive'],
    [types[0], 'write'],
  ] as const) {
    const values = childElements(node);
    if (values.length !== 1 || !isDav(values[0], type)) throw new XmlParseError('仅支持独占写锁');
    requireEmpty(values[0]);
  }
  const owner = owners[0];
  if (!owner) return { scope: 'exclusive', type: 'write', owner: null, ownerHref: false };
  const ownerChildren = owner.children.filter(
    (child): child is XmlNode => typeof child !== 'string',
  );
  if (!ownerChildren.length)
    return { scope: 'exclusive', type: 'write', owner: plainText(owner), ownerHref: false };
  if (owner.hasAttributes || ownerChildren.length !== 1 || !isDav(ownerChildren[0], 'href'))
    throw new XmlParseError('锁所有者仅支持文本或 DAV:href');
  childElements(owner);
  return { scope: 'exclusive', type: 'write', owner: plainText(ownerChildren[0]), ownerHref: true };
}
