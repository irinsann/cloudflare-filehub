export const GOOGLE_DRIVE_FOLDER = 'application/vnd.google-apps.folder';
export const GOOGLE_DRIVE_CHUNK_SIZE = 16 * 1024 * 1024;
export interface GoogleDriveCapabilities {
  canEdit?: boolean;
  canDownload?: boolean;
  canTrash?: boolean;
  canUntrash?: boolean;
  canDelete?: boolean;
  canAddChildren?: boolean;
  canRename?: boolean;
  canMoveItemWithinDrive?: boolean;
}
export interface GoogleDriveExportFormat {
  id: string;
  label: string;
  mime: string;
  extension: string;
}
export interface GoogleDriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
  parents?: string[];
  trashed?: boolean;
  webViewLink?: string;
  capabilities?: GoogleDriveCapabilities;
  shortcutDetails?: { targetId: string; targetMimeType: string };
  exportFormats?: GoogleDriveExportFormat[];
}
export interface GoogleDriveListing {
  files: GoogleDriveFile[];
  nextPageToken?: string;
}
export interface GoogleDriveStatus {
  configured: boolean;
  connected: boolean;
  connectionId?: string;
  needsReconnect?: boolean;
  error?: string;
  account?: { displayName?: string; emailAddress?: string };
  storageQuota?: {
    limit?: string;
    usage?: string;
    usageInDrive?: string;
    usageInDriveTrash?: string;
  };
  redirectUris: string[];
}
export interface GoogleDriveUpload {
  id: string;
  chunkSize: number;
  offset: number;
  complete: boolean;
  file?: GoogleDriveFile;
}
