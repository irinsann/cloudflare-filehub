import type { AppContext } from './env';
import type { FileRecord } from '../shared/types';
import { identifier } from '../shared/validation';
import { fail } from './errors';

export function uploadOwnerStatements(c: AppContext, fileId: string) {
  const tokenId = c.get('apiTokenId');
  return tokenId
    ? [
        c.env.DB.prepare('INSERT INTO api_file_owners(file_id,token_id) VALUES(?,?)').bind(
          fileId,
          tokenId,
        ),
      ]
    : [];
}
export async function requireUploadOwner(c: AppContext, fileId: string) {
  identifier.parse(fileId);
  const owner = await c.env.DB.prepare(
    'SELECT file_id FROM api_file_owners WHERE file_id=? AND token_id=?',
  )
    .bind(fileId, c.get('apiTokenId'))
    .first();
  if (!owner) fail(404, '上传文件不存在');
}
export function uploadMetadata(c: AppContext, file: FileRecord) {
  if (!c.get('apiTokenId')) return file;
  return {
    id: file.id,
    name: file.name,
    size: file.size,
    mime: file.mime,
    folder_id: file.folder_id,
    status: file.status,
    created_at: file.created_at,
    updated_at: file.updated_at,
  };
}
