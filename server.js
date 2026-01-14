require("dotenv").config();
const express = require("express");
const cors = require("cors");
const db = require("./db");
const { syncPosts } = require("./sync");

const app = express();

// CORS configuration
const allowedOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(",").map((o) => o.trim())
  : [];

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (like mobile apps or curl)
      if (!origin) return callback(null, true);
      
      // Allow localhost:3001 for local development
      if (origin === "http://localhost:3001") {
        return callback(null, true);
      }
      
      // Allow any Vercel preview/production domain
      if (origin.endsWith(".vercel.app")) {
        return callback(null, true);
      }
      
      // Allow explicitly listed origins
      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      
      return callback(new Error("Not allowed by CORS"));
    },
  })
);
app.use(express.json());

// Admin token auth middleware
const requireAdmin = (req, res, next) => {
  const token = req.headers["x-admin-token"];
  const adminToken = process.env.ADMIN_TOKEN;

  if (!adminToken) {
    return res.status(500).json({ error: "ADMIN_TOKEN not configured" });
  }

  if (token !== adminToken) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
};

// Health check endpoint
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Manual sync endpoint (protected)
app.post("/api/sync", requireAdmin, async (req, res) => {
  try {
    const result = await syncPosts();
    res.json({ success: true, ...result });
  } catch (err) {
    console.error("Sync failed:", err.message);
    const response = {
      success: false,
      error: err.message,
    };
    // Only include details in non-production
    if (process.env.NODE_ENV !== "production") {
      response.details = err.response?.data || null;
    }
    res.status(500).json(response);
  }
});

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
      if (err) {
        res.status(500).json({ error: "Database error" });
        return;
      }
      if (!row) {
        res.status(404).json({ error: "Not found" });
        return;
      }
      res.json(row);
    }
  );
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`API running on port ${PORT}`);
  console.log(`CORS allowed origins: ${allowedOrigins.join(", ")}`);
});
