require("dotenv").config();
const axios = require("axios");
const db = require("./db");

const PAGE_ID = process.env.FB_PAGE_ID;
const PAGE_TOKEN = process.env.FB_PAGE_TOKEN;

if (!PAGE_ID || !PAGE_TOKEN) {
  console.error("Missing FB_PAGE_ID or FB_PAGE_TOKEN in .env");
  process.exit(1);
}

async function fetchPosts() {
  try {
    const res = await axios.get(
      `https://graph.facebook.com/v24.0/${PAGE_ID}/posts`,
      {
        params: {
          access_token: PAGE_TOKEN,
          fields: "id,message,full_picture,created_time,permalink_url",
          limit: 10,
        },
      }
    );

    const posts = res.data.data;

    posts.forEach((post) => {
      if (!post.message) return;

      const lines = post.message
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);

      if (lines.length === 0) return;

      const headline = lines[0];

      let body = lines.slice(1).join("\n");

      // Remove ads / separators if present
      if (body.includes("--------------------------------------------")) {
        body = body.split("--------------------------------------------")[0];
      }

      body = body.trim();

      db.run(
        `
        INSERT OR IGNORE INTO articles
        (fb_post_id, headline, body, image_url, published_at, source_url, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
        [
          post.id,
          headline,
          body,
          post.full_picture || null,
          post.created_time,
          post.permalink_url,
          new Date().toISOString(),
        ]
      );
    });

    console.log("Posts synced:", posts.length);
  } catch (err) {
    console.error("Facebook fetch failed:");
    if (err.response) {
      console.error(err.response.data);
    } else {
      console.error(err.message);
    }
  }
}

fetchPosts();
