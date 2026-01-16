const axios = require("axios");
const db = require("./db");

/**
 * Fetches posts from Facebook and saves to database
 * Returns a promise with sync results
 */
async function syncPosts() {
  const PAGE_ID = process.env.FB_PAGE_ID;
  const PAGE_TOKEN = process.env.FB_PAGE_TOKEN;

  if (!PAGE_ID || !PAGE_TOKEN) {
    throw new Error("Missing FB_PAGE_ID or FB_PAGE_TOKEN");
  }

  console.log(`[${new Date().toISOString()}] Starting Facebook sync...`);

  const res = await axios.get(
    `https://graph.facebook.com/v24.0/${PAGE_ID}/posts`,
    {
      params: {
        access_token: PAGE_TOKEN,
        fields: "id,message,full_picture,created_time,permalink_url",
        limit: 20,
      },
    }
  );

  const posts = res.data.data;
  let saved = 0;
  let skipped = 0;

  for (const post of posts) {
    if (!post.message) {
      skipped++;
      continue;
    }

    const lines = post.message
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    if (lines.length === 0) {
      skipped++;
      continue;
    }

    // Get headline: first line, or first sentence if line is too long
    let headline = lines[0];
    
    // If first line has a period and is long, use first sentence as headline
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

    // Use promise wrapper for db.run
    const result = await new Promise((resolve) => {
      db.run(
        `INSERT OR IGNORE INTO articles
         (fb_post_id, headline, body, image_url, published_at, source_url, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          post.id,
          headline,
          body,
          post.full_picture || null,
          post.created_time,
          post.permalink_url,
          new Date().toISOString(),
        ],
        function (err) {
          if (err) {
            console.error("DB insert error:", err.message);
            resolve({ saved: false });
          } else {
            resolve({ saved: this.changes > 0 });
          }
        }
      );
    });

    if (result.saved) {
      saved++;
    } else {
      skipped++;
    }
  }

  const summary = {
    timestamp: new Date().toISOString(),
    fetched: posts.length,
    saved,
    skipped,
  };

  console.log(`[${summary.timestamp}] Sync complete:`, summary);
  return summary;
}

module.exports = { syncPosts };
