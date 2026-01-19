const axios = require("axios");
const supabase = require("./supabase");

// Sync configuration
const SYNC_COOLDOWN = 5 * 60 * 1000; // 5 minutes minimum between syncs

/**
 * Get last sync timestamp from database
 */
async function getLastSyncTime() {
  const { data, error } = await supabase
    .from("sync_meta")
    .select("value")
    .eq("key", "last_fb_sync")
    .single();

  if (error || !data) return 0;
  return parseInt(data.value) || 0;
}

/**
 * Update last sync timestamp in database
 */
async function setLastSyncTime(timestamp) {
  await supabase
    .from("sync_meta")
    .upsert({ key: "last_fb_sync", value: timestamp.toString() });
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
 * Get existing fb_post_ids to skip (including modified ones)
 */
async function getExistingPostIds() {
  // Get ALL existing fb_post_ids - we never update, only insert new
  const { data, error } = await supabase
    .from("articles")
    .select("fb_post_id, is_modified")
    .not("fb_post_id", "is", null);

  if (error) throw error;
  return new Set(data.map((r) => r.fb_post_id));
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

  let headline = lines[0];
  if (headline.includes(".") && headline.length > 100) {
    const firstSentence = headline.split(".")[0];
    if (firstSentence.length >= 20) {
      headline = firstSentence + ".";
    }
  }

  let body = lines.slice(1).join("\n");
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
 */
async function syncPosts(force = false) {
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

  const existingIds = await getExistingPostIds();
  console.log(`Found ${existingIds.size} existing Facebook posts in database`);

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
    if (existingIds.has(post.id)) {
      skippedExisting++;
      continue;
    }

    const article = parsePost(post);
    if (!article) {
      skippedNoContent++;
      continue;
    }

    const { error } = await supabase.from("articles").insert({
      fb_post_id: article.fb_post_id,
      headline: article.headline,
      body: article.body,
      image_url: article.image_url,
      published_at: article.published_at,
      source_url: article.source_url,
      source: "facebook",
      is_modified: false,
      is_hidden: false,
      created_at: new Date().toISOString(),
    });

    if (!error) {
      inserted++;
      console.log(`  + Inserted: ${article.headline.slice(0, 50)}...`);
    }
  }

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

let lazySyncPromise = null;

async function lazySync() {
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
