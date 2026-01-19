const axios = require("axios");
const db = require("./db");

// Sync configuration
const SYNC_COOLDOWN = 5 * 60 * 1000; // 5 minutes minimum between syncs

/**
 * Get last sync timestamp from database
 */
function getLastSyncTime() {
  return new Promise((resolve) => {
    db.get("SELECT value FROM sync_meta WHERE key = 'last_fb_sync'", (err, row) => {
      if (err || !row) return resolve(0);
      resolve(parseInt(row.value) || 0);
    });
  });
}

/**
 * Update last sync timestamp in database
 */
function setLastSyncTime(timestamp) {
  return new Promise((resolve) => {
    db.run(
      "INSERT OR REPLACE INTO sync_meta (key, value) VALUES ('last_fb_sync', ?)",
      [timestamp.toString()],
      () => resolve()
    );
  });
}

/**
 * Check if sync should run (respects cooldown)
 */
async function shouldSync() {
  const lastSync = await getLastSyncTime();
  const now = Date.now();
  return now - lastSync >= SYNC_COOLDOWN;
}

/**
 * Get existing fb_post_ids to skip
 */
function getExistingPostIds() {
  return new Promise((resolve, reject) => {
    db.all("SELECT fb_post_id FROM articles WHERE source = 'facebook'", (err, rows) => {
      if (err) return reject(err);
      const ids = new Set(rows.map((r) => r.fb_post_id));
      resolve(ids);
    });
  });
}

/**
 * Parse Facebook post into article data
 */
function parsePost(post) {
  if (!post.message) return null;

  const lines = post.message
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length === 0) return null;

  // Get headline: first line, or first sentence if line is too long
  let headline = lines[0];
  if (headline.includes(".") && headline.length > 100) {
    const firstSentence = headline.split(".")[0];
    if (firstSentence.length >= 20) {
      headline = firstSentence + ".";
    }
  }

  // Build body from remaining content
  let body = lines.slice(1).join("\n");

  // Remove ads / separators if present
  if (body.includes("--------------------------------------------")) {
    body = body.split("--------------------------------------------")[0];
  }
  body = body.trim();

  return {
    fb_post_id: post.id,
    headline,
    body,
    image_url: post.full_picture || null,
    published_at: post.created_time,
    source_url: post.permalink_url,
  };
}

/**
 * INSERT-ONLY sync: Only inserts new posts, never updates existing ones
 * Skips posts that already exist in the database
 */
async function syncPosts(force = false) {
  // Check cooldown unless forced
  if (!force) {
    const canSync = await shouldSync();
    if (!canSync) {
      const lastSync = await getLastSyncTime();
      const waitTime = Math.round((SYNC_COOLDOWN - (Date.now() - lastSync)) / 1000);
      return { skipped: true, reason: `Cooldown active, wait ${waitTime}s` };
    }
  }

  const PAGE_ID = process.env.FB_PAGE_ID;
  const PAGE_TOKEN = process.env.FB_PAGE_TOKEN;

  if (!PAGE_ID || !PAGE_TOKEN) {
    throw new Error("Missing FB_PAGE_ID or FB_PAGE_TOKEN");
  }

  console.log(`[${new Date().toISOString()}] Starting Facebook sync (INSERT-ONLY)...`);

  // Get existing post IDs to skip
  const existingIds = await getExistingPostIds();
  console.log(`Found ${existingIds.size} existing Facebook posts in database`);

  // Fetch recent posts from Facebook (only latest 25)
  const res = await axios.get(
    `https://graph.facebook.com/v24.0/${PAGE_ID}/posts`,
    {
      params: {
        access_token: PAGE_TOKEN,
        fields: "id,message,full_picture,created_time,permalink_url",
        limit: 25,
      },
    }
  );

  const posts = res.data.data;
  let inserted = 0;
  let skippedExisting = 0;
  let skippedNoContent = 0;

  for (const post of posts) {
    // Skip if already exists
    if (existingIds.has(post.id)) {
      skippedExisting++;
      continue;
    }

    // Parse post
    const article = parsePost(post);
    if (!article) {
      skippedNoContent++;
      continue;
    }

    // INSERT only (no update)
    const result = await new Promise((resolve) => {
      db.run(
        `INSERT INTO articles 
         (fb_post_id, headline, body, image_url, published_at, source_url, source, is_modified, is_hidden, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'facebook', 0, 0, ?)`,
        [
          article.fb_post_id,
          article.headline,
          article.body,
          article.image_url,
          article.published_at,
          article.source_url,
          new Date().toISOString(),
        ],
        function (err) {
          if (err) {
            // Could be duplicate (race condition) - just skip
            resolve({ inserted: false });
          } else {
            resolve({ inserted: this.changes > 0 });
          }
        }
      );
    });

    if (result.inserted) {
      inserted++;
      console.log(`  + Inserted: ${article.headline.slice(0, 50)}...`);
    }
  }

  // Update last sync time
  await setLastSyncTime(Date.now());

  const result = {
    inserted,
    skippedExisting,
    skippedNoContent,
    total: posts.length,
    timestamp: new Date().toISOString(),
  };

  console.log(`Sync complete: ${inserted} inserted, ${skippedExisting} already existed, ${skippedNoContent} no content`);
  return result;
}

/**
 * Lazy sync: triggers sync only if cooldown has passed
 * Safe to call on every API request
 */
let lazySyncPromise = null;

async function lazySync() {
  // Don't start another sync if one is running
  if (lazySyncPromise) return lazySyncPromise;

  const canSync = await shouldSync();
  if (!canSync) return null;

  console.log("Lazy sync triggered...");
  lazySyncPromise = syncPosts(true)
    .catch((err) => {
      console.error("Lazy sync failed:", err.message);
      return { error: err.message };
    })
    .finally(() => {
      lazySyncPromise = null;
    });

  return lazySyncPromise;
}

module.exports = { syncPosts, lazySync, shouldSync, getLastSyncTime };
