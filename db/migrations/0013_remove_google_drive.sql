-- Retire only the optional Google Drive integration. R2 files and public shares are untouched.
DROP TABLE IF EXISTS google_drive_uploads;
DROP TABLE IF EXISTS google_drive_oauth;
DROP TABLE IF EXISTS google_drive_connections;
DROP TABLE IF EXISTS google_drive_generation;
