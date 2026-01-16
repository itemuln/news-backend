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

      // Allow localhost for local development (any port)
      if (origin.startsWith("http://localhost:")) {
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

// Auto-sync state
let initialSyncPromise = null;
let lastSyncAt = 0; // Track last successful sync time
let autoSyncPromise = null; // Prevent concurrent auto-syncs
const AUTO_SYNC_INTERVAL = 10 * 60 * 1000; // 10 minutes in ms

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

// Helper: ensure initial sync is done (all callers await the same promise)
async function ensureInitialSync() {
  // If sync already completed or in progress, return existing promise
  if (initialSyncPromise !== null) {
    return initialSyncPromise;
  }

  // Check if DB is empty
  const countCheck = await new Promise((resolve, reject) => {
    db.get("SELECT COUNT(*) as total FROM articles", (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });

  if (countCheck.total === 0) {
    console.log("Database empty, running initial sync...");
    // Create and store promise so concurrent requests wait on the same sync
    initialSyncPromise = syncPosts()
      .then((result) => {
        console.log("Initial sync complete:", result);
        lastSyncAt = Date.now(); // Update sync timestamp
      })
      .catch((err) => {
        console.error("Initial sync failed:", err.message);
      });
    return initialSyncPromise;
  } else {
    // DB not empty, mark as done with resolved promise
    initialSyncPromise = Promise.resolve();
    // Set lastSyncAt to now so we don't immediately trigger auto-sync
    lastSyncAt = Date.now();
    return initialSyncPromise;
  }
}

// Helper: trigger auto-sync if stale (non-blocking, shared promise)
function triggerAutoSyncIfNeeded() {
  const now = Date.now();
  
  // Skip if within sync interval
  if (now - lastSyncAt < AUTO_SYNC_INTERVAL) {
    return;
  }
  
  // Skip if auto-sync already in progress
  if (autoSyncPromise !== null) {
    return;
  }
  
  console.log(`Auto-sync triggered (${Math.round((now - lastSyncAt) / 60000)} min since last sync)`);
  
  // Run sync in background (non-blocking)
  autoSyncPromise = syncPosts()
    .then((result) => {
      console.log("Auto-sync complete:", result);
      lastSyncAt = Date.now();
    })
    .catch((err) => {
      console.error("Auto-sync failed:", err.message);
    })
    .finally(() => {
      autoSyncPromise = null; // Allow next auto-sync
    });
}

// Health check endpoint
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Manual sync endpoint (protected)
app.post("/api/sync", requireAdmin, async (req, res) => {
  try {
    const result = await syncPosts();
    lastSyncAt = Date.now(); // Update sync timestamp
    res.json({ success: true, ...result });
  } catch (err) {
    console.error("Sync failed:", err.message);
    const response = {
      success: false,
      error: err.message,
    };
    if (process.env.NODE_ENV !== "production") {
      response.details = err.response?.data || null;
    }
    res.status(500).json(response);
  }
});

// Get all articles (with pagination)
app.get("/api/articles", async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const offset = (page - 1) * limit;

  try {
    // Wait for initial sync to complete (all requests wait on same promise)
    await ensureInitialSync();
  } catch (err) {
    console.error("Error during initial sync check:", err.message);
  }

  // Trigger auto-sync if data is stale (non-blocking)
  triggerAutoSyncIfNeeded();

  // Get total count
  db.get("SELECT COUNT(*) as total FROM articles", (err, countResult) => {
    if (err) {
      res.status(500).json({ error: "Database error" });
      return;
    }

    const total = countResult.total;
    const totalPages = Math.ceil(total / limit);

    // Get paginated articles (include fb_post_id for stable links)
    db.all(
      "SELECT id, fb_post_id, headline, image_url, published_at FROM articles ORDER BY published_at DESC LIMIT ? OFFSET ?",
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
          totalPages,
        });
      }
    );
  });
});

// Get single article by fb_post_id (stable identifier)
app.get("/api/articles/by-fb/:fb_post_id", (req, res) => {
  db.get(
    "SELECT * FROM articles WHERE fb_post_id = ?",
    [req.params.fb_post_id],
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
  console.log("API running on port " + PORT);
  console.log("CORS allowed origins: " + allowedOrigins.join(", "));
});
