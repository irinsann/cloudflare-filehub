export interface FileRecord {
  id: string;
  name: string;
  object_key: string;
  folder_id: string | null;
  mime: string;
  size: number;
  etag: string | null;
  version: number;
  status: 'pending' | 'ready' | 'deleting';
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}
export interface FolderRecord {
  id: string;
  name: string;
  parent_id: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}
export interface ShareRecord {
  id: string;
  file_id: string;
  token_hash: string;
  password_hash: string | null;
  created_at: number;
  expires_at: number | null;
  enabled: number;
  allow_download: number;
  views: number;
  downloads: number;
  last_access_at: number | null;
  name?: string;
}
export interface PageRecord {
  id: string;
  file_id: string;
  title: string;
  slug: string;
  description: string;
  published: number;
  published_at: number | null;
  updated_at: number;
  snapshot_key: string | null;
  published_version: number | null;
  allow_source: number;
  allow_index: number;
  views: number;
}
export interface AttachmentRecord {
  id: string;
  file_id: string;
  object_key: string;
  mime: string;
  size: number;
  created_at: number;
}
export interface Listing {
  files: FileRecord[];
  folders: FolderRecord[];
  total: number;
  page: number;
  limit: number;
}
export interface Settings {
  authMode?: string;
  maxUploadBytes: null;
  storageUsedBytes: number;
  storageLimitBytes: number;
  storageAvailableBytes: number;
  maxTextBytes: number;
  environment: string;
  email: string;
  filesOrigin: string;
  markdownOrigin: string;
}
