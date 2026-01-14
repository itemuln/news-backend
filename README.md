# MKOR News Backend

Backend API that fetches posts from a Facebook Page and serves them as news articles.

## Features

- Fetches posts from Facebook Graph API
- Parses posts: first line → headline, rest → body
- Stores in SQLite database
- RESTful API with pagination
- Manual sync endpoint (protected)
- Optional scheduled sync via cron

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health` | Health check |
| GET | `/api/articles?page=1&limit=10` | List articles (paginated) |
| GET | `/api/articles/:id` | Get single article |
| POST | `/api/sync` | Trigger Facebook sync (requires `X-Admin-Token` header) |

## Local Development

### 1. Install dependencies

```bash
npm install
```

### 2. Create `.env` file

```env
FB_PAGE_ID=your_facebook_page_id
FB_PAGE_TOKEN=your_facebook_page_access_token
ADMIN_TOKEN=your_secret_admin_token
```

### 3. Run the server

```bash
npm start
```

### 4. Manual sync (CLI)

```bash
npm run sync
```

## Render Deployment

### 1. Create Web Service

- Connect your GitHub repo
- Build Command: `npm install`
- Start Command: `npm start`

### 2. Set Environment Variables

| Variable | Value | Description |
|----------|-------|-------------|
| `FB_PAGE_ID` | `221114308769986` | Your Facebook Page ID |
| `FB_PAGE_TOKEN` | `EAAU...` | Facebook Page Access Token |
| `ADMIN_TOKEN` | (generate a random string) | Secret token for sync endpoint |
| `CORS_ORIGINS` | `https://news-frontend.vercel.app` | Additional allowed origins (comma-separated) |
| `NODE_ENV` | `production` | Set to production for security |

### CORS Configuration

The backend automatically allows:
- `http://localhost:3001` (local development)
- Any origin ending with `.vercel.app` (Vercel preview & production)
- Origins explicitly listed in `CORS_ORIGINS`

If your frontend is on a custom domain, add it to `CORS_ORIGINS`:

```
CORS_ORIGINS=https://news.example.com,https://staging.example.com
```

### 3. Attach Persistent Disk

1. Go to your Render service → **Disks**
2. Add a new disk:
   - **Name:** `news-data`
   - **Mount Path:** `/var/data`
   - **Size:** 1 GB (minimum)

This ensures your database persists across deploys and restarts.

### 4. Set Up Scheduled Sync (Render Cron Job)

**Do NOT use in-process cron.** Use Render Cron Jobs instead for reliability.

1. Go to Render Dashboard → **New** → **Cron Job**
2. Configure:
   - **Name:** `news-sync`
   - **Schedule:** `*/10 * * * *` (every 10 minutes)
   - **Command:**
     ```bash
     curl -X POST https://YOUR-SERVICE.onrender.com/api/sync -H "X-Admin-Token: YOUR_ADMIN_TOKEN"
     ```

Replace `YOUR-SERVICE` with your Render service name and `YOUR_ADMIN_TOKEN` with your actual token.

## Manual Sync via API

```bash
curl -X POST https://your-service.onrender.com/api/sync \
  -H "X-Admin-Token: your_admin_token"
```

Response:
```json
{
  "success": true,
  "timestamp": "2026-01-14T12:00:00.000Z",
  "fetched": 20,
  "saved": 5,
  "skipped": 15
}
```

## Facebook Token Renewal

Facebook Page tokens expire. When your token expires:

1. Go to [Graph API Explorer](https://developers.facebook.com/tools/explorer/)
2. Generate a new User Token with permissions:
   - `pages_read_engagement`
   - `pages_read_user_content`
   - `pages_show_list`
3. Run `GET /me/accounts`
4. Copy the new Page `access_token`
5. Update `FB_PAGE_TOKEN` in Render environment variables
6. Redeploy or restart the service

## File Structure

```
news-backend/
├── server.js      # Express API server
├── db.js          # SQLite database setup
├── sync.js        # Facebook sync logic
├── fetchPosts.js  # CLI sync script
├── cron.js        # Standalone cron (optional)
├── package.json
├── .gitignore
└── README.md
```

## License

ISC
