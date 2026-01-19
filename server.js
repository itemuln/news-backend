require("dotenv").config();
const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const db = require("./db");
const { syncPosts, lazySync, getLastSyncTime } = require("./sync");

const app = express();

// JWT secret (use env var in production)
const JWT_SECRET = process.env.JWT_SECRET || "your-secret-key-change-in-production";

// CORS configuration
const allowedOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(",").map((o) => o.trim())
  : [];

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (origin.startsWith("http://localhost:")) return callback(null, true);
      if (origin.endsWith(".vercel.app")) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error("Not allowed by CORS"));
    },
  })
);
app.use(express.json());

// ===== Middleware =====

// Legacy admin token auth (for sync endpoint)
const requireAdminToken = (req, res, next) => {
  const token = req.headers["x-admin-token"];
  const adminToken = process.env.ADMIN_TOKEN;
  if (!adminToken) return res.status(500).json({ error: "ADMIN_TOKEN not configured" });
  if (token !== adminToken) return res.status(401).json({ error: "Unauthorized" });
  next();
};

// JWT auth middleware
const requireAuth = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "No token provided" });
  }
  
  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid token" });
  }
};

// ===== Public Routes =====

app.get("/api/health", async (req, res) => {
  const lastSync = await getLastSyncTime();
  res.json({ 
    status: "ok", 
    timestamp: new Date().toISOString(),
    lastSync: lastSync ? new Date(lastSync).toISOString() : null
  });
});

// Get all articles (with pagination) - triggers lazy sync
app.get("/api/articles", async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const offset = (page - 1) * limit;

  // Trigger lazy sync in background (non-blocking)
  lazySync();

  db.get("SELECT COUNT(*) as total FROM articles WHERE is_hidden = 0", (err, countResult) => {
    if (err) return res.status(500).json({ error: "Database error" });

    const total = countResult.total;
    const totalPages = Math.ceil(total / limit);

    db.all(
      `SELECT id, fb_post_id, headline, image_url, published_at, source, is_modified 
       FROM articles WHERE is_hidden = 0 
       ORDER BY published_at DESC LIMIT ? OFFSET ?`,
      [limit, offset],
      (err, rows) => {
        if (err) return res.status(500).json({ error: "Database error" });
        res.json({ items: rows, page, limit, total, totalPages });
      }
    );
  });
});

// Get single article by fb_post_id
app.get("/api/articles/by-fb/:fb_post_id", (req, res) => {
  db.get("SELECT * FROM articles WHERE fb_post_id = ? AND is_hidden = 0", [req.params.fb_post_id], (err, row) => {
    if (err) return res.status(500).json({ error: "Database error" });
    if (!row) return res.status(404).json({ error: "Not found" });
    res.json(row);
  });
});

// Get single article by ID
app.get("/api/articles/:id", (req, res) => {
  db.get("SELECT * FROM articles WHERE id = ? AND is_hidden = 0", [req.params.id], (err, row) => {
    if (err) return res.status(500).json({ error: "Database error" });
    if (!row) return res.status(404).json({ error: "Not found" });
    res.json(row);
  });
});

// Manual sync endpoint (protected by legacy token)
app.post("/api/sync", requireAdminToken, async (req, res) => {
  try {
    const result = await syncPosts(true); // force sync
    res.json({ success: true, ...result });
  } catch (err) {
    console.error("Sync failed:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ===== Admin Auth Routes =====

// Admin login
app.post("/api/admin/login", (req, res) => {
  const { username, password } = req.body;
  
  if (!username || !password) {
    return res.status(400).json({ error: "Username and password required" });
  }

  db.get("SELECT * FROM admin_users WHERE username = ?", [username], async (err, user) => {
    if (err) return res.status(500).json({ error: "Database error" });
    if (!user) return res.status(401).json({ error: "Invalid credentials" });

    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) return res.status(401).json({ error: "Invalid credentials" });

    const token = jwt.sign(
      { id: user.id, username: user.username },
      JWT_SECRET,
      { expiresIn: "24h" }
    );

    res.json({ token, username: user.username });
  });
});

// Verify token
app.get("/api/admin/verify", requireAuth, (req, res) => {
  res.json({ valid: true, user: req.user });
});

// ===== Admin CRUD Routes =====

// Get all articles for admin (with more details, including hidden)
app.get("/api/admin/articles", requireAuth, (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const offset = (page - 1) * limit;

  db.get("SELECT COUNT(*) as total FROM articles", (err, countResult) => {
    if (err) return res.status(500).json({ error: "Database error" });

    const total = countResult.total;
    const totalPages = Math.ceil(total / limit);

    db.all(
      "SELECT * FROM articles ORDER BY published_at DESC LIMIT ? OFFSET ?",
      [limit, offset],
      (err, rows) => {
        if (err) return res.status(500).json({ error: "Database error" });
        res.json({ items: rows, page, limit, total, totalPages });
      }
    );
  });
});

// Create article (admin-created)
app.post("/api/admin/articles", requireAuth, (req, res) => {
  const { headline, body, image_url } = req.body;

  if (!headline) {
    return res.status(400).json({ error: "Headline is required" });
  }

  const now = new Date().toISOString();
  const adminPostId = `admin_${Date.now()}`;

  db.run(
    `INSERT INTO articles (fb_post_id, headline, body, image_url, published_at, source, is_modified, is_hidden, created_at)
     VALUES (?, ?, ?, ?, ?, 'admin', 1, 0, ?)`,
    [adminPostId, headline, body || "", image_url || null, now, now],
    function (err) {
      if (err) {
        console.error("Insert error:", err);
        return res.status(500).json({ error: "Database error" });
      }
      res.status(201).json({
        id: this.lastID,
        fb_post_id: adminPostId,
        headline,
        body,
        image_url,
        published_at: now,
        source: "admin",
        is_modified: 1,
      });
    }
  );
});

// Update article (sets is_modified = 1 to protect from sync overwrite)
app.put("/api/admin/articles/:id", requireAuth, (req, res) => {
  const { headline, body, image_url } = req.body;
  const { id } = req.params;

  if (!headline) {
    return res.status(400).json({ error: "Headline is required" });
  }

  db.run(
    "UPDATE articles SET headline = ?, body = ?, image_url = ?, is_modified = 1 WHERE id = ?",
    [headline, body || "", image_url || null, id],
    function (err) {
      if (err) return res.status(500).json({ error: "Database error" });
      if (this.changes === 0) return res.status(404).json({ error: "Article not found" });
      res.json({ success: true, is_modified: 1 });
    }
  );
});

// Toggle article visibility (hide/show)
app.patch("/api/admin/articles/:id/visibility", requireAuth, (req, res) => {
  const { id } = req.params;
  const { is_hidden } = req.body;

  db.run(
    "UPDATE articles SET is_hidden = ? WHERE id = ?",
    [is_hidden ? 1 : 0, id],
    function (err) {
      if (err) return res.status(500).json({ error: "Database error" });
      if (this.changes === 0) return res.status(404).json({ error: "Article not found" });
      res.json({ success: true, is_hidden: is_hidden ? 1 : 0 });
    }
  );
});

// Delete article
app.delete("/api/admin/articles/:id", requireAuth, (req, res) => {
  const { id } = req.params;

  db.run("DELETE FROM articles WHERE id = ?", [id], function (err) {
    if (err) return res.status(500).json({ error: "Database error" });
    if (this.changes === 0) return res.status(404).json({ error: "Article not found" });
    res.json({ success: true });
  });
});

// Setup endpoint - create admin user (protected by ADMIN_TOKEN)
app.post("/api/setup-admin", async (req, res) => {
  const { setupKey, username, password } = req.body;
  
  if (!process.env.ADMIN_TOKEN || setupKey !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: "Invalid setup key" });
  }
  
  if (!username || !password) {
    return res.status(400).json({ error: "Username and password required" });
  }
  
  const passwordHash = await bcrypt.hash(password, 10);
  
  db.run(
    "INSERT INTO admin_users (username, password_hash) VALUES (?, ?)",
    [username, passwordHash],
    function (err) {
      if (err) {
        if (err.message.includes("UNIQUE")) {
          return res.status(400).json({ error: "Username already exists" });
        }
        return res.status(500).json({ error: "Database error" });
      }
      res.json({ success: true, message: `Admin '${username}' created!` });
    }
  );
});

// ===== Start Server =====

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("API running on port " + PORT);
  console.log("CORS allowed origins: " + allowedOrigins.join(", "));
});
