require("dotenv").config();
const { syncPosts } = require("./sync");

// CLI script to manually trigger sync
syncPosts()
  .then((result) => {
    console.log("Sync completed:", result);
    process.exit(0);
  })
  .catch((err) => {
    console.error("Sync failed:", err.message);
    process.exit(1);
  });
