-- Run this in Supabase SQL Editor to create the tables

-- Articles table
CREATE TABLE IF NOT EXISTS articles (
  id SERIAL PRIMARY KEY,
  fb_post_id TEXT UNIQUE,
  headline TEXT,
  body TEXT,
  image_url TEXT,
  published_at TIMESTAMPTZ,
  source_url TEXT,
  source TEXT DEFAULT 'facebook',
  is_modified BOOLEAN DEFAULT FALSE,
  is_hidden BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for faster lookups
CREATE INDEX IF NOT EXISTS idx_articles_fb_post_id ON articles(fb_post_id);
CREATE INDEX IF NOT EXISTS idx_articles_published_at ON articles(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_articles_is_hidden ON articles(is_hidden);

-- Admin users table
CREATE TABLE IF NOT EXISTS admin_users (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Sync metadata table
CREATE TABLE IF NOT EXISTS sync_meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- Insert default sync meta
INSERT INTO sync_meta (key, value) VALUES ('last_fb_sync', '0')
ON CONFLICT (key) DO NOTHING;
