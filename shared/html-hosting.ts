export interface HtmlHostingItem {
  file_id: string;
  share_id: string;
  name: string;
  size: number;
  enabled: boolean;
  version: number;
  created_at: number;
  expires_at: number | null;
  password_protected: boolean;
  views: number;
  downloads: number;
  last_access_at: number | null;
  url: string;
  directUrl: string;
}

export interface HtmlHostingListing {
  data: HtmlHostingItem[];
  total: number;
  page: number;
  limit: number;
}
