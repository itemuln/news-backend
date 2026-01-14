const sqlite3 = require("sqlite3").verbose();

const db = new sqlite3.Database("./news.db");

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
