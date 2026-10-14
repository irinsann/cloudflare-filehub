export function sharexConfig(origin: string, token = 'REPLACE_WITH_IMAGE_UPLOAD_TOKEN') {
  return {
    Version: '17.0.0',
    Name: 'RCloud 图床',
    DestinationType: 'ImageUploader',
    RequestMethod: 'POST',
    RequestURL: new URL('/api/v1/images', origin).href,
    Headers: { Authorization: `Bearer ${token}` },
    Body: 'MultipartFormData',
    FileFormName: 'file',
    URL: '{json:data.url}',
    ErrorMessage: '{json:error.message}',
  };
}
