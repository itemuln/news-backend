-- Run this in Supabase SQL Editor to create/update the tables

-- Article media table (images/videos - multiple per article)
CREATE TABLE IF NOT EXISTS article_media (
  id SERIAL PRIMARY KEY,
  article_id INTEGER REFERENCES articles(id) ON DELETE CASCADE,
  media_type TEXT DEFAULT 'image', -- 'image' or 'video'
  url TEXT NOT NULL,
  alt_text TEXT,
  position INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_article_media_article_id ON article_media(article_id);

-- Articles table with new columns
CREATE TABLE IF NOT EXISTS articles (
  id SERIAL PRIMARY KEY,
  fb_post_id TEXT UNIQUE,
  headline TEXT,
  body TEXT,
  image_url TEXT,
  banner_media_id INTEGER REFERENCES article_media(id) ON DELETE SET NULL,
  published_at TIMESTAMPTZ,
  source_url TEXT,
  source TEXT DEFAULT 'facebook',
  is_modified BOOLEAN DEFAULT FALSE,
  is_hidden BOOLEAN DEFAULT FALSE,
  is_featured BOOLEAN DEFAULT FALSE,
  featured_position INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_articles_fb_post_id ON articles(fb_post_id);
CREATE INDEX IF NOT EXISTS idx_articles_published_at ON articles(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_articles_is_hidden ON articles(is_hidden);
CREATE INDEX IF NOT EXISTS idx_articles_is_featured ON articles(is_featured);
CREATE INDEX IF NOT EXISTS idx_articles_featured_position ON articles(featured_position);

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

-- ============================================
-- MIGRATION: Run these if tables already exist
-- ============================================

-- Add new columns to articles (run if table exists)
ALTER TABLE articles ADD COLUMN IF NOT EXISTS banner_media_id INTEGER REFERENCES article_media(id) ON DELETE SET NULL;
ALTER TABLE articles ADD COLUMN IF NOT EXISTS is_featured BOOLEAN DEFAULT FALSE;
ALTER TABLE articles ADD COLUMN IF NOT EXISTS featured_position INTEGER DEFAULT 0;
