require("dotenv").config();
const sqlite3 = require("sqlite3").verbose();
const fs = require("fs");
const path = require("path");

// Determine database path
function getDbPath() {
  if (process.env.DB_PATH) return process.env.DB_PATH;
  if (fs.existsSync("/var/data")) return "/var/data/news.db";
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
  // Articles table with all columns
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
      is_modified INTEGER DEFAULT 0,
      is_hidden INTEGER DEFAULT 0,
      created_at TEXT
    )
  `);

  // Migrations for existing databases
  const migrations = [
    "ALTER TABLE articles ADD COLUMN source TEXT DEFAULT 'facebook'",
    "ALTER TABLE articles ADD COLUMN is_modified INTEGER DEFAULT 0",
    "ALTER TABLE articles ADD COLUMN is_hidden INTEGER DEFAULT 0",
  ];
  
  migrations.forEach((sql) => {
    db.run(sql, () => {}); // Ignore errors if column exists
  });

  // Sync metadata table - tracks last sync time
  db.run(`
    CREATE TABLE IF NOT EXISTS sync_meta (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  // Admin users table
  db.run(`
    CREATE TABLE IF NOT EXISTS admin_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Auto-create default admin if none exists
  db.get("SELECT COUNT(*) as count FROM admin_users", (err, row) => {
    if (err) return;
    if (row.count === 0 && process.env.DEFAULT_ADMIN_PASS) {
      const bcrypt = require("bcryptjs");
      const hash = bcrypt.hashSync(process.env.DEFAULT_ADMIN_PASS, 10);
      db.run(
        "INSERT INTO admin_users (username, password_hash) VALUES (?, ?)",
        ["admin", hash],
        (err) => {
          if (!err) console.log("Default admin user created automatically");
        }
      );
    }
  });
});

module.exports = db;
