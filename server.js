require("dotenv").config();
const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const supabase = require("./supabase");
const { syncPosts, lazySync, getLastSyncTime } = require("./sync");

const app = express();

const JWT_SECRET = process.env.JWT_SECRET || "your-secret-key-change-in-production";

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

const requireAdminToken = (req, res, next) => {
  const token = req.headers["x-admin-token"];
  const adminToken = process.env.ADMIN_TOKEN;
  if (!adminToken) return res.status(500).json({ error: "ADMIN_TOKEN not configured" });
  if (token !== adminToken) return res.status(401).json({ error: "Unauthorized" });
  next();
};

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
    lastSync: lastSync ? new Date(lastSync).toISOString() : null,
  });
});

// Get all articles (with pagination) - triggers lazy sync
app.get("/api/articles", async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const offset = (page - 1) * limit;

  // Trigger lazy sync in background
  lazySync();

  try {
    // Get total count
    const { count, error: countError } = await supabase
      .from("articles")
      .select("*", { count: "exact", head: true })
      .eq("is_hidden", false);

    if (countError) throw countError;

    const total = count || 0;
    const totalPages = Math.ceil(total / limit);

    // Get articles
    const { data, error } = await supabase
      .from("articles")
      .select("id, fb_post_id, headline, image_url, published_at, source, is_modified")
      .eq("is_hidden", false)
      .order("published_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;

    res.json({ items: data, page, limit, total, totalPages });
  } catch (err) {
    console.error("Error fetching articles:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// Get single article by fb_post_id
app.get("/api/articles/by-fb/:fb_post_id", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("articles")
      .select("*")
      .eq("fb_post_id", req.params.fb_post_id)
      .eq("is_hidden", false)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: "Not found" });
    }
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Database error" });
  }
});

// Get single article by ID
app.get("/api/articles/:id", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("articles")
      .select("*")
      .eq("id", req.params.id)
      .eq("is_hidden", false)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: "Not found" });
    }
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Database error" });
  }
});

// Manual sync endpoint
app.post("/api/sync", requireAdminToken, async (req, res) => {
  try {
    const result = await syncPosts(true);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error("Sync failed:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ===== Admin Auth Routes =====

app.post("/api/admin/login", async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: "Username and password required" });
  }

  try {
    const { data: user, error } = await supabase
      .from("admin_users")
      .select("*")
      .eq("username", username)
      .single();

    if (error || !user) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const token = jwt.sign(
      { id: user.id, username: user.username },
      JWT_SECRET,
      { expiresIn: "24h" }
    );

    res.json({ token, username: user.username });
  } catch (err) {
    res.status(500).json({ error: "Database error" });
  }
});

app.get("/api/admin/verify", requireAuth, (req, res) => {
  res.json({ valid: true, user: req.user });
});

// ===== Admin CRUD Routes =====

app.get("/api/admin/articles", requireAuth, async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const offset = (page - 1) * limit;

  try {
    const { count } = await supabase
      .from("articles")
      .select("*", { count: "exact", head: true });

    const total = count || 0;
    const totalPages = Math.ceil(total / limit);

    const { data, error } = await supabase
      .from("articles")
      .select("*")
      .order("published_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;

    res.json({ items: data, page, limit, total, totalPages });
  } catch (err) {
    res.status(500).json({ error: "Database error" });
  }
});

// Create article
app.post("/api/admin/articles", requireAuth, async (req, res) => {
  const { headline, body, image_url } = req.body;

  if (!headline) {
    return res.status(400).json({ error: "Headline is required" });
  }

  const now = new Date().toISOString();
  const adminPostId = `admin_${Date.now()}`;

  try {
    const { data, error } = await supabase
      .from("articles")
      .insert({
        fb_post_id: adminPostId,
        headline,
        body: body || "",
        image_url: image_url || null,
        published_at: now,
        source: "admin",
        is_modified: true,
        is_hidden: false,
        created_at: now,
      })
      .select()
      .single();

    if (error) throw error;

    res.status(201).json(data);
  } catch (err) {
    console.error("Insert error:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// Update article
app.put("/api/admin/articles/:id", requireAuth, async (req, res) => {
  const { headline, body, image_url } = req.body;
  const { id } = req.params;

  if (!headline) {
    return res.status(400).json({ error: "Headline is required" });
  }

  try {
    const { data, error } = await supabase
      .from("articles")
      .update({
        headline,
        body: body || "",
        image_url: image_url || null,
        is_modified: true,
      })
      .eq("id", id)
      .select()
      .single();

    if (error || !data) {
      return res.status(404).json({ error: "Article not found" });
    }

    res.json({ success: true, is_modified: true });
  } catch (err) {
    res.status(500).json({ error: "Database error" });
  }
});

// Toggle visibility
app.patch("/api/admin/articles/:id/visibility", requireAuth, async (req, res) => {
  const { id } = req.params;
  const { is_hidden } = req.body;

  try {
    const { data, error } = await supabase
      .from("articles")
      .update({ is_hidden: !!is_hidden })
      .eq("id", id)
      .select()
      .single();

    if (error || !data) {
      return res.status(404).json({ error: "Article not found" });
    }

    res.json({ success: true, is_hidden: data.is_hidden });
  } catch (err) {
    res.status(500).json({ error: "Database error" });
  }
});

// Delete article
app.delete("/api/admin/articles/:id", requireAuth, async (req, res) => {
  const { id } = req.params;

  try {
    const { error } = await supabase
      .from("articles")
      .delete()
      .eq("id", id);

    if (error) throw error;

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Database error" });
  }
});

// Setup admin endpoint
app.post("/api/setup-admin", async (req, res) => {
  const { setupKey, username, password } = req.body;

  if (!process.env.ADMIN_TOKEN || setupKey !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: "Invalid setup key" });
  }

  if (!username || !password) {
    return res.status(400).json({ error: "Username and password required" });
  }

  try {
    const passwordHash = await bcrypt.hash(password, 10);

    const { error } = await supabase.from("admin_users").insert({
      username,
      password_hash: passwordHash,
    });

    if (error) {
      if (error.code === "23505") {
        return res.status(400).json({ error: "Username already exists" });
      }
      throw error;
    }

    res.json({ success: true, message: `Admin '${username}' created!` });
  } catch (err) {
    res.status(500).json({ error: "Database error" });
  }
});

// ===== Start Server =====

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("API running on port " + PORT);
  console.log("CORS allowed origins: " + allowedOrigins.join(", "));
});
