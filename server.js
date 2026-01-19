require("dotenv").config();
const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const supabase = require("./supabase");
const { syncPosts, lazySync, getLastSyncTime } = require("./sync");

const app = express();

// Configure multer for file uploads (in memory)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
  fileFilter: (req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/gif", "image/webp", "video/mp4", "video/webm"];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Invalid file type"), false);
    }
  },
});

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
app.use(express.json({ limit: "10mb" }));

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

// Get featured articles for carousel (admin-controlled, NOT by recency)
app.get("/api/articles/featured", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("articles")
      .select("id, fb_post_id, headline, image_url, published_at, source")
      .eq("is_hidden", false)
      .eq("is_featured", true)
      .order("featured_position", { ascending: true })
      .limit(10);

    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error("Error fetching featured:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// Get all articles (with pagination) - triggers lazy sync
app.get("/api/articles", async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const offset = (page - 1) * limit;

  lazySync();

  try {
    const { count, error: countError } = await supabase
      .from("articles")
      .select("*", { count: "exact", head: true })
      .eq("is_hidden", false);

    if (countError) throw countError;

    const total = count || 0;
    const totalPages = Math.ceil(total / limit);

    const { data, error } = await supabase
      .from("articles")
      .select("id, fb_post_id, headline, image_url, published_at, source, is_modified, is_featured")
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

// Get single article by fb_post_id (with media)
app.get("/api/articles/by-fb/:fb_post_id", async (req, res) => {
  try {
    const { data: article, error } = await supabase
      .from("articles")
      .select("*")
      .eq("fb_post_id", req.params.fb_post_id)
      .eq("is_hidden", false)
      .single();

    if (error || !article) {
      return res.status(404).json({ error: "Not found" });
    }

    // Get associated media
    const { data: media } = await supabase
      .from("article_media")
      .select("*")
      .eq("article_id", article.id)
      .order("position", { ascending: true });

    res.json({ ...article, media: media || [] });
  } catch (err) {
    res.status(500).json({ error: "Database error" });
  }
});

// Get single article by ID (with media)
app.get("/api/articles/:id", async (req, res) => {
  try {
    const { data: article, error } = await supabase
      .from("articles")
      .select("*")
      .eq("id", req.params.id)
      .eq("is_hidden", false)
      .single();

    if (error || !article) {
      return res.status(404).json({ error: "Not found" });
    }

    const { data: media } = await supabase
      .from("article_media")
      .select("*")
      .eq("article_id", article.id)
      .order("position", { ascending: true });

    res.json({ ...article, media: media || [] });
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

// ===== Admin Article CRUD =====

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
  const { headline, body, image_url, is_featured, featured_position } = req.body;

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
        is_featured: is_featured || false,
        featured_position: featured_position || 0,
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

// Update article (sets is_modified = true)
app.put("/api/admin/articles/:id", requireAuth, async (req, res) => {
  const { headline, body, image_url, banner_media_id, is_featured, featured_position } = req.body;
  const { id } = req.params;

  if (!headline) {
    return res.status(400).json({ error: "Headline is required" });
  }

  try {
    const updateData = {
      headline,
      body: body || "",
      image_url: image_url || null,
      is_modified: true,
    };

    if (banner_media_id !== undefined) updateData.banner_media_id = banner_media_id;
    if (is_featured !== undefined) updateData.is_featured = is_featured;
    if (featured_position !== undefined) updateData.featured_position = featured_position;

    const { data, error } = await supabase
      .from("articles")
      .update(updateData)
      .eq("id", id)
      .select()
      .single();

    if (error || !data) {
      return res.status(404).json({ error: "Article not found" });
    }

    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ error: "Database error" });
  }
});

// Toggle featured status
app.patch("/api/admin/articles/:id/featured", requireAuth, async (req, res) => {
  const { id } = req.params;
  const { is_featured, featured_position } = req.body;

  try {
    const { data, error } = await supabase
      .from("articles")
      .update({
        is_featured: !!is_featured,
        featured_position: featured_position || 0,
        is_modified: true,
      })
      .eq("id", id)
      .select()
      .single();

    if (error || !data) {
      return res.status(404).json({ error: "Article not found" });
    }

    res.json({ success: true, is_featured: data.is_featured, featured_position: data.featured_position });
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
      .update({ is_hidden: !!is_hidden, is_modified: true })
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
    // Delete associated media first
    await supabase.from("article_media").delete().eq("article_id", id);

    const { error } = await supabase.from("articles").delete().eq("id", id);

    if (error) throw error;

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Database error" });
  }
});

// ===== Admin Media Routes =====

// Get media for an article
app.get("/api/admin/articles/:id/media", requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("article_media")
      .select("*")
      .eq("article_id", req.params.id)
      .order("position", { ascending: true });

    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: "Database error" });
  }
});

// Add media to article (by URL)
app.post("/api/admin/articles/:id/media", requireAuth, async (req, res) => {
  const { url, media_type, alt_text, position } = req.body;
  const article_id = req.params.id; // UUID string, not parseInt

  if (!url) {
    return res.status(400).json({ error: "URL is required" });
  }

  try {
    // Mark article as modified
    await supabase.from("articles").update({ is_modified: true }).eq("id", article_id);

    const { data, error } = await supabase
      .from("article_media")
      .insert({
        article_id,
        url,
        media_type: media_type || "image",
        alt_text: alt_text || null,
        position: position || 0,
      })
      .select()
      .single();

    if (error) throw error;

    res.status(201).json(data);
  } catch (err) {
    console.error("Media insert error:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// Update media
app.put("/api/admin/media/:id", requireAuth, async (req, res) => {
  const { url, media_type, alt_text, position } = req.body;
  const { id } = req.params;

  try {
    // Get article_id first to mark as modified
    const { data: media } = await supabase
      .from("article_media")
      .select("article_id")
      .eq("id", id)
      .single();

    if (media?.article_id) {
      await supabase.from("articles").update({ is_modified: true }).eq("id", media.article_id);
    }

    const { data, error } = await supabase
      .from("article_media")
      .update({
        url: url || undefined,
        media_type: media_type || undefined,
        alt_text: alt_text || undefined,
        position: position !== undefined ? position : undefined,
      })
      .eq("id", id)
      .select()
      .single();

    if (error || !data) {
      return res.status(404).json({ error: "Media not found" });
    }

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Database error" });
  }
});

// Delete media
app.delete("/api/admin/media/:id", requireAuth, async (req, res) => {
  const { id } = req.params;

  try {
    // Get article_id first to mark as modified
    const { data: media } = await supabase
      .from("article_media")
      .select("article_id")
      .eq("id", id)
      .single();

    if (media?.article_id) {
      await supabase.from("articles").update({ is_modified: true }).eq("id", media.article_id);
    }

    const { error } = await supabase.from("article_media").delete().eq("id", id);

    if (error) throw error;

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Database error" });
  }
});

// Upload media file to Supabase Storage
app.post("/api/admin/articles/:id/upload", requireAuth, upload.single("file"), async (req, res) => {
  const article_id = req.params.id;
  const { alt_text, position } = req.body;

  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }

  try {
    // Generate unique filename
    const ext = req.file.originalname.split(".").pop();
    const filename = `${article_id}/${Date.now()}-${Math.random().toString(36).substring(7)}.${ext}`;

    // Upload to Supabase Storage
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from("article-media")
      .upload(filename, req.file.buffer, {
        contentType: req.file.mimetype,
        cacheControl: "3600",
      });

    if (uploadError) {
      console.error("Upload error:", uploadError);
      return res.status(500).json({ error: "Failed to upload file" });
    }

    // Get public URL
    const { data: urlData } = supabase.storage.from("article-media").getPublicUrl(filename);
    const url = urlData.publicUrl;

    // Determine media type
    const media_type = req.file.mimetype.startsWith("video/") ? "video" : "image";

    // Mark article as modified
    await supabase.from("articles").update({ is_modified: true }).eq("id", article_id);

    // Insert media record
    const { data, error } = await supabase
      .from("article_media")
      .insert({
        article_id,
        url,
        media_type,
        alt_text: alt_text || null,
        position: parseInt(position) || 0,
      })
      .select()
      .single();

    if (error) throw error;

    res.status(201).json(data);
  } catch (err) {
    console.error("Media upload error:", err);
    res.status(500).json({ error: "Failed to save media" });
  }
});

// Set banner media for article
app.patch("/api/admin/articles/:id/banner", requireAuth, async (req, res) => {
  const { id } = req.params;
  const { banner_media_id } = req.body;

  try {
    const { data, error } = await supabase
      .from("articles")
      .update({ banner_media_id, is_modified: true })
      .eq("id", id)
      .select()
      .single();

    if (error || !data) {
      return res.status(404).json({ error: "Article not found" });
    }

    res.json({ success: true, banner_media_id: data.banner_media_id });
  } catch (err) {
    res.status(500).json({ error: "Database error" });
  }
});

// Bulk update featured positions
app.post("/api/admin/articles/featured/reorder", requireAuth, async (req, res) => {
  const { items } = req.body; // Array of { id, featured_position }

  if (!Array.isArray(items)) {
    return res.status(400).json({ error: "Items array required" });
  }

  try {
    for (const item of items) {
      await supabase
        .from("articles")
        .update({ featured_position: item.featured_position, is_modified: true })
        .eq("id", item.id);
    }

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
