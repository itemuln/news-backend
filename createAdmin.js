// Script to create an admin user
// Usage: node createAdmin.js <username> <password>

const bcrypt = require("bcryptjs");
const db = require("./db");

const username = process.argv[2];
const password = process.argv[3];

if (!username || !password) {
  console.log("Usage: node createAdmin.js <username> <password>");
  process.exit(1);
}

async function createAdmin() {
  const passwordHash = await bcrypt.hash(password, 10);

  db.run(
    "INSERT INTO admin_users (username, password_hash) VALUES (?, ?)",
    [username, passwordHash],
    function (err) {
      if (err) {
        if (err.message.includes("UNIQUE constraint failed")) {
          console.error("Error: Username already exists");
        } else {
          console.error("Error:", err.message);
        }
        process.exit(1);
      }
      console.log(`Admin user '${username}' created successfully!`);
      process.exit(0);
    }
  );
}

createAdmin();
