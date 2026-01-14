const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const cors = require("cors");

const app = express();
const db = new sqlite3.Database("./news.db");

app.use(cors());
app.use(express.json());

// Get all articles (with pagination)
app.get("/api/articles", (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const offset = (page - 1) * limit;

  // First get total count
  db.get("SELECT COUNT(*) as total FROM articles", (err, countResult) => {
    if (err) {
      res.status(500).json({ error: "Database error" });
      return;
    }

    const total = countResult.total;
    const totalPages = Math.ceil(total / limit);

    // Then get paginated articles
    db.all(
      `SELECT id, headline, image_url, published_at 
       FROM articles 
       ORDER BY published_at DESC
       LIMIT ? OFFSET ?`,
      [limit, offset],
      (err, rows) => {
        if (err) {
          res.status(500).json({ error: "Database error" });
          return;
        }
        res.json({
          items: rows,
          page,
          limit,
          total,
          totalPages
        });
      }
    );
  });
});

// Get single article
app.get("/api/articles/:id", (req, res) => {
  db.get(
    "SELECT * FROM articles WHERE id = ?",
    [req.params.id],
    (err, row) => {
      if (!row) {
        res.status(404).json({ error: "Not found" });
        return;
      }
      res.json(row);
    }
  );
});

app.listen(3000, () => {
  console.log("API running on http://localhost:3000");
});
