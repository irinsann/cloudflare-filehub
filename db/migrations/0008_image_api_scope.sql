ALTER TABLE api_tokens ADD COLUMN scope TEXT NOT NULL DEFAULT 'files:upload' CHECK(scope IN ('files:upload','images:upload'));
