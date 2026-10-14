import { Hono } from 'hono';
import type { AppEnv } from './env';
import { uploadRoutes } from './uploads';
import { getFile, uploadSingleFile } from './files';
import { requireUploadOwner, uploadMetadata } from './upload-access';
import { fail } from './errors';

export const uploadApi = new Hono<AppEnv>();
uploadApi.post('/files', uploadSingleFile);
uploadApi.get('/files/:id', async (c) => {
  await requireUploadOwner(c, c.req.param('id'));
  return c.json({ data: uploadMetadata(c, await getFile(c.env, c.req.param('id'))) });
});
uploadApi.route('/', uploadRoutes);
uploadApi.all('*', () => fail(404, 'API 接口不存在'));
