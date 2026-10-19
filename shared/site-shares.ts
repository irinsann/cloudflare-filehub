export interface SiteShareListItem {
  id: string;
  folder_id: string;
  name: string;
  url: string;
  enabled: boolean;
  password_protected: boolean;
  created_at: number;
  expires_at: number | null;
  views: number;
  last_access_at: number | null;
}

export interface SiteShareCreateInput {
  folder_id: string;
  password?: string;
  expires_in_days?: number | null;
}
