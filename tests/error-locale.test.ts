import { describe, expect, it } from 'vitest';
import { translateError } from '../worker/error-locale';
import { filename } from '../shared/validation';

describe('application error localization', () => {
  it.each([
    ['请求来源校验失败', 'Request origin verification failed'],
    ['密码至少 12 个字符', 'The password must contain at least 12 characters'],
    ['分享已过期或已撤销', 'The share has expired or has been revoked'],
    ['文件大小校验失败', 'File size verification failed'],
    ['存储容量不足（总容量 50GB）', 'Insufficient storage space. The total capacity is 50 GB.'],
    ['HTML 分享不存在', 'HTML share not found'],
    ['文件夹中没有 index.html', 'The folder does not contain index.html'],
  ])('translates the complete error without changing its meaning: %s', (source, expected) => {
    expect(translateError(source, 'en')).toBe(expected);
    expect(translateError(source, 'zh')).toBe(source);
  });

  it('translates actual custom Zod validation errors and preserves English defaults', () => {
    const parsed = filename.safeParse('../private.txt');
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const error = parsed.error.issues.map((issue) => issue.message).join('; ');
    expect(translateError(error, 'en')).toBe(
      'File names cannot contain paths or control characters',
    );
    const joined =
      '文件不存在; 密码至少 12 个字符； Invalid input: expected number, received string';
    expect(translateError(joined, 'en')).toBe(
      'File not found; The password must contain at least 12 characters； Invalid input: expected number, received string',
    );
    expect(translateError(joined, 'zh')).toBe(joined);
  });

  it('preserves unknown messages, document text, file names and object prototype names', () => {
    for (const source of [
      '新的诊断信息',
      '文件不存在.md',
      '文章内容：文件不存在',
      '<p>文件不存在</p>',
      'constructor',
      '__proto__',
      'toString',
      'Network error',
    ]) {
      expect(translateError(source, 'en')).toBe(source);
    }
  });

  it('keeps all instructions in a known message containing a semicolon', () => {
    expect(translateError('WebDAV单次上传最多100MB；大文件请使用网页分片上传', 'en')).toBe(
      'WebDAV uploads are limited to 100 MB per request. Use multipart upload on the website for larger files.',
    );
    expect(translateError('单次COPY最多12项，请分批复制', 'en')).toBe(
      'A single COPY request supports up to 12 items. Copy them in smaller batches.',
    );
    expect(translateError('备注：单次COPY最多12项，请分批复制', 'en')).toBe(
      '备注：单次COPY最多12项，请分批复制',
    );
  });
});
