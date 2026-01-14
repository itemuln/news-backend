const cron = require("node-cron");

// Run fetchPosts every 10 minutes
cron.schedule("*/10 * * * *", () => {
  console.log("Running scheduled fetch at", new Date().toLocaleString());
  
  // Clear require cache to get fresh execution
  delete require.cache[require.resolve("./fetchPosts")];
  require("./fetchPosts");
});

console.log("Cron job started. Fetching posts every 10 minutes.");
console.log("Press Ctrl+C to stop.");

// Run once immediately on startup
require("./fetchPosts");
