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
  db.run(`
    CREATE TABLE IF NOT EXISTS articles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fb_post_id TEXT UNIQUE,
      headline TEXT,
      body TEXT,
      image_url TEXT,
      published_at TEXT,
      source_url TEXT,
      created_at TEXT
    )
  `);
});

module.exports = db;
