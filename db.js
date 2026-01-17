require("dotenv").config();
const sqlite3 = require("sqlite3").verbose();
const fs = require("fs");
const path = require("path");

// Determine database path
function getDbPath() {
  // 1. If DB_PATH is set, use it
  if (process.env.DB_PATH) {
    return process.env.DB_PATH;
  }
  
  // 2. If /var/data exists (Render persistent disk), use it
  if (fs.existsSync("/var/data")) {
    return "/var/data/news.db";
  }
  
  // 3. Fallback to local
  return "./news.db";
}

const DB_PATH = getDbPath();

// Ensure directory exists
const dbDir = path.dirname(DB_PATH);
if (dbDir !== "." && !fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
  console.log(`Created directory: ${dbDir}`);
}

console.log(`Using database at: ${DB_PATH}`);

const db = new sqlite3.Database(DB_PATH);

db.serialize(() => {
  // Articles table
  db.run(`
    CREATE TABLE IF NOT EXISTS articles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fb_post_id TEXT UNIQUE,
      headline TEXT,
      body TEXT,
      image_url TEXT,
      published_at TEXT,
      source_url TEXT,
      source TEXT DEFAULT 'facebook',
      created_at TEXT
    )
  `);

  // Add source column if it doesn't exist (migration)
  db.run(`ALTER TABLE articles ADD COLUMN source TEXT DEFAULT 'facebook'`, (err) => {
    // Ignore error if column already exists
  });

  // Admin users table
  db.run(`
    CREATE TABLE IF NOT EXISTS admin_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
});

module.exports = db;
