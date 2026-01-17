require("dotenv").config();
const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const db = require("./db");
const { syncPosts } = require("./sync");

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

// ===== Auto-sync state =====
let initialSyncPromise = null;
let lastSyncAt = 0;
let autoSyncPromise = null;
const AUTO_SYNC_INTERVAL = 10 * 60 * 1000;

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

// ===== Helper functions =====

async function ensureInitialSync() {
  if (initialSyncPromise !== null) return initialSyncPromise;

  const countCheck = await new Promise((resolve, reject) => {
    db.get("SELECT COUNT(*) as total FROM articles", (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });

  if (countCheck.total === 0) {
    console.log("Database empty, running initial sync...");
    initialSyncPromise = syncPosts()
      .then((result) => {
        console.log("Initial sync complete:", result);
        lastSyncAt = Date.now();
      })
      .catch((err) => console.error("Initial sync failed:", err.message));
    return initialSyncPromise;
  } else {
    initialSyncPromise = Promise.resolve();
    lastSyncAt = Date.now();
    return initialSyncPromise;
  }
}

function triggerAutoSyncIfNeeded() {
  const now = Date.now();
  if (now - lastSyncAt < AUTO_SYNC_INTERVAL) return;
  if (autoSyncPromise !== null) return;
  
  console.log(`Auto-sync triggered (${Math.round((now - lastSyncAt) / 60000)} min since last sync)`);
  autoSyncPromise = syncPosts()
    .then((result) => {
      console.log("Auto-sync complete:", result);
      lastSyncAt = Date.now();
    })
    .catch((err) => console.error("Auto-sync failed:", err.message))
    .finally(() => { autoSyncPromise = null; });
}

// ===== Public Routes =====

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Get all articles (with pagination)
app.get("/api/articles", async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const offset = (page - 1) * limit;

  try {
    await ensureInitialSync();
  } catch (err) {
    console.error("Error during initial sync check:", err.message);
  }

  triggerAutoSyncIfNeeded();

  db.get("SELECT COUNT(*) as total FROM articles", (err, countResult) => {
    if (err) return res.status(500).json({ error: "Database error" });

    const total = countResult.total;
    const totalPages = Math.ceil(total / limit);

    db.all(
      "SELECT id, fb_post_id, headline, image_url, published_at, source FROM articles ORDER BY published_at DESC LIMIT ? OFFSET ?",
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
  db.get("SELECT * FROM articles WHERE fb_post_id = ?", [req.params.fb_post_id], (err, row) => {
    if (err) return res.status(500).json({ error: "Database error" });
    if (!row) return res.status(404).json({ error: "Not found" });
    res.json(row);
  });
});

// Get single article by ID
app.get("/api/articles/:id", (req, res) => {
  db.get("SELECT * FROM articles WHERE id = ?", [req.params.id], (err, row) => {
    if (err) return res.status(500).json({ error: "Database error" });
    if (!row) return res.status(404).json({ error: "Not found" });
    res.json(row);
  });
});

// Manual sync endpoint (protected by legacy token)
app.post("/api/sync", requireAdminToken, async (req, res) => {
  try {
    const result = await syncPosts();
    lastSyncAt = Date.now();
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

// Get all articles for admin (with more details)
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

// Create article
app.post("/api/admin/articles", requireAuth, (req, res) => {
  const { headline, body, image_url } = req.body;

  if (!headline) {
    return res.status(400).json({ error: "Headline is required" });
  }

  const now = new Date().toISOString();
  const adminPostId = `admin_${Date.now()}`;

  db.run(
    `INSERT INTO articles (fb_post_id, headline, body, image_url, published_at, source, created_at)
     VALUES (?, ?, ?, ?, ?, 'admin', ?)`,
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
      });
    }
  );
});

// Update article
app.put("/api/admin/articles/:id", requireAuth, (req, res) => {
  const { headline, body, image_url } = req.body;
  const { id } = req.params;

  if (!headline) {
    return res.status(400).json({ error: "Headline is required" });
  }

  db.run(
    "UPDATE articles SET headline = ?, body = ?, image_url = ? WHERE id = ?",
    [headline, body || "", image_url || null, id],
    function (err) {
      if (err) return res.status(500).json({ error: "Database error" });
      if (this.changes === 0) return res.status(404).json({ error: "Article not found" });
      res.json({ success: true });
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

// ===== Start Server =====

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("API running on port " + PORT);
  console.log("CORS allowed origins: " + allowedOrigins.join(", "));
});
