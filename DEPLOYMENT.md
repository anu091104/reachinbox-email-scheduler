# Deployment

## Why a VM and not Railway, Render or Vercel functions?

This app needs three things that most free platforms don't give you together:

1. **Outbound SMTP (port 587) to reach Ethereal.** Railway disables outbound SMTP on its Free, Trial and Hobby plans, and Render's free web services have blocked ports 25, 465 and 587 since September 2025. On those platforms the app would deploy fine, but every email would time out.
2. **An always-on worker.** Delayed jobs only fire if a worker is running. Free tiers that sleep when idle (Render free, serverless functions) would send emails late, or only when someone happens to open the site.
3. **Redis with persistence, plus Elasticsearch.**

A small Linux VM running `docker-compose.prod.yml` gives you all three, works the same as your laptop, and makes the restart demo straightforward (`docker compose restart backend`).

**Recommended for students: Azure for Students.** It gives $100 of credit, needs no credit card, and only needs your university email. Azure allows outbound 587. Any other VM with at least 4 GB RAM (AWS EC2, Google Compute Engine, Oracle Cloud) works with exactly the same steps.

---

## 1. Create the VM (Azure)

1. Activate Azure for Students at https://azure.microsoft.com/free/students with your university email.
2. Azure Portal → **Virtual machines → Create**:
   - Image: **Ubuntu Server 24.04 LTS**
   - Size: **B2s** (2 vCPU, 4 GB RAM). Elasticsearch needs the memory.
   - Authentication: SSH public key, or a password
   - Inbound ports: allow **SSH (22), HTTP (80), HTTPS (443)**
3. After it's created, copy the **Public IP address** (for example `20.193.45.12`).

> To save credit, stop the VM from the portal when you don't need it. The data on its disk stays.

## 2. Connect

From Windows PowerShell:
```powershell
ssh azureuser@20.193.45.12
```

## 3. Install Docker
```bash
git clone https://github.com/<your-username>/reachinbox-email-scheduler.git
cd reachinbox-email-scheduler
bash deploy/setup-ubuntu.sh
newgrp docker
```

## 4. Configure
```bash
cp deploy/production.env.example .env.production
nano .env.production
```
- `SITE_ADDRESS`: your IP with dashes, plus `.sslip.io`. For example, `20.193.45.12` becomes `20-193-45-12.sslip.io`. [sslip.io](https://sslip.io) is a free DNS service that resolves that name back to your IP, which lets Caddy get a real HTTPS certificate automatically, with no domain purchase needed.
- `POSTGRES_PASSWORD`, `JWT_SECRET`, `BULL_BOARD_PASSWORD`: long random strings. To generate one:
  `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`, or `openssl rand -hex 48`.
- `GOOGLE_CLIENT_ID`: in Google Cloud Console, add `https://20-193-45-12.sslip.io` under **Authorized JavaScript origins** of the same OAuth client.

## 5. Launch
```bash
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
docker compose -f docker-compose.prod.yml ps        # wait for everything to be healthy/running
docker compose -f docker-compose.prod.yml logs -f backend
```
Open `https://20-193-45-12.sslip.io`. The queue dashboard is at `/admin/queues`.

Every container has `restart: unless-stopped`, so the whole stack comes back by itself after a VM reboot, and scheduled emails still go out.

## 6. Updating
```bash
git pull
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
```
Migrations run automatically when the backend starts.

## 7. Demonstrating restart persistence on the live server
```bash
# schedule a few emails a minute or two out in the dashboard, then:
docker compose -f docker-compose.prod.yml stop backend
# wait past the scheduled time…
docker compose -f docker-compose.prod.yml start backend
docker compose -f docker-compose.prod.yml logs backend | grep -E "reconciliation|email sent"
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| Elasticsearch keeps restarting | Run `sysctl vm.max_map_count` and check it's 262144 (the setup script sets this). Use a VM with 4 GB RAM. |
| Caddy can't get a certificate | Ports 80 and 443 must be open in the Azure network security group, and `SITE_ADDRESS` must match the VM's public IP. |
| Emails stuck in "Scheduled", with `ETIMEDOUT` in the logs | The host is blocking outbound SMTP port 587. Use a different provider or VM. |
| Google popup says "origin not allowed" | Add the exact `https://…sslip.io` origin to the OAuth client and wait a few minutes. |

---

## Free option: Vercel + Render + Neon + Redis Cloud + Elastic Cloud

Everything below is free and needs no card. It has more moving parts than the VM, and two workarounds:

- **Render's free tier blocks SMTP port 587.** The backend sends through port **2525** instead (`SMTP_PORT_OVERRIDE=2525`). Check Ethereal accepts it first (step 0).
- **Render's free tier sleeps after 15 minutes without traffic.** A free uptime monitor pings `/health` every 5 minutes to keep the worker awake. This is a keep-alive, not a scheduler: emails are still timed by BullMQ delayed jobs.

| Piece | Service (free) |
|---|---|
| Frontend | Vercel |
| API + BullMQ worker | Render web service (free instance) |
| PostgreSQL | Neon |
| Redis | Redis Cloud (30 MB free database) |
| Elasticsearch | Elastic Cloud (14-day trial; search falls back to Postgres afterwards) |
| Keep-alive | UptimeRobot |

### 0. Check Ethereal on port 2525 (from your laptop)
```powershell
Test-NetConnection smtp.ethereal.email -Port 2525
```
`TcpTestSucceeded : True` means this route works. If it's `False`, emails can't leave Render's free tier; use the VM route above instead.

### 1. Neon (Postgres)
1. Sign up at https://neon.tech with GitHub → **Create project** `reachinbox`, region **AWS Asia Pacific (Singapore)**.
2. **Connect** → turn **Connection pooling off** → copy the connection string (`postgresql://…neon.tech/neondb?sslmode=require`).

### 2. Redis Cloud
1. Sign up at https://redis.io/try-free → create a **Free** (30 MB) database, region close to Singapore or Mumbai.
2. Open the database → **Configuration → Edit → Data eviction policy: `noeviction`** → Save (BullMQ needs this).
3. Copy the public endpoint and the default user's password, and build:
   `redis://default:<password>@<public-endpoint-host>:<port>`

### 3. Elastic Cloud
1. Start the free trial at https://cloud.elastic.co → create a **hosted** deployment (any region in Asia).
2. Copy the **Elasticsearch endpoint** (`https://….es.….cloud.es.io`).
3. **Management → API keys → Create API key** → copy the **encoded** key.

### 4. Render (backend)
1. https://render.com → sign up with GitHub → **New → Web Service** → pick your repo.
2. Settings:

| Field | Value |
|---|---|
| Root Directory | `backend` |
| Runtime | **Node** |
| Region | **Singapore** |
| Build Command | `npm ci --include=dev && npm run build` |
| Start Command | `node dist/index.js` |
| Instance Type | **Free** |
| Health Check Path (Advanced) | `/health` |

3. **Environment variables:**
```
NODE_ENV=production
DATABASE_URL=<Neon connection string>
DATABASE_SSL=true
REDIS_URL=<Redis Cloud URL>
ELASTICSEARCH_URL=<Elastic endpoint>
ELASTICSEARCH_API_KEY=<encoded API key>
JWT_SECRET=<64+ random characters>
GOOGLE_CLIENT_ID=<your Google client ID>
FRONTEND_ORIGIN=https://<your-app>.vercel.app
COOKIE_SECURE=true
TRUST_PROXY=true
SMTP_PORT_OVERRIDE=2525
BULL_BOARD_PASSWORD=<a strong password>
```
4. **Create Web Service**. When the log shows `API listening`, copy the URL (`https://<name>.onrender.com`) and open `/health`: it should say `"status":"ok"`.

### 5. Vercel (frontend)
1. In `frontend/vercel.json`, replace `YOUR-BACKEND-DOMAIN` with your Render host (`<name>.onrender.com`), then commit and push.
2. https://vercel.com → sign up with GitHub → **Add New → Project** → import the repo → **Root Directory: `frontend`** (Vite is detected) → **Deploy**.
3. Copy the Vercel URL and set it as `FRONTEND_ORIGIN` on Render (Render redeploys).

The rewrite in `vercel.json` sends `/api/*` to Render, so the browser only ever talks to the Vercel domain and the session cookie stays first-party.

### 6. Google login
Google Cloud → **Clients** → your client → **Authorized JavaScript origins** → add `https://<your-app>.vercel.app`.

### 7. Keep the worker awake
https://uptimerobot.com → **New monitor** → HTTP(s) → URL `https://<name>.onrender.com/health` → interval **5 minutes**.

### If emails time out on Render ("Last attempt failed (Timeout)")
Render can block port 2525 too. Then split the roles:
1. On Render, add `PROCESS_ROLE=api` (Render now only serves the API).
2. On a machine with SMTP access (your laptop works), create `backend/.env.cloud` with the same values as Render, but without `SMTP_PORT_OVERRIDE` and with `AUTO_PROVISION_SENDERS=0`. It is git-ignored.
3. Start the worker against the cloud services:
   ```powershell
   cd backend
   $env:DOTENV_CONFIG_PATH=".env.cloud"; npm run dev:worker
   ```
   Emails scheduled on the live site are sent by this worker while it runs; anything due while it's off is sent as soon as it starts (boot reconciliation).

### 8. Test
Open the Vercel URL → sign in → Compose → send. The queue dashboard is at `https://<name>.onrender.com/admin/queues`. To show a restart, use **Manual Deploy → Restart service** on Render.

---

## Alternative: split hosting (paid tiers)

If you'd rather use managed services:

- **Frontend:** Vercel. Set the project root to `frontend/` and replace `YOUR-BACKEND-DOMAIN` in `frontend/vercel.json`. The rewrite proxies `/api` so the session cookie stays first-party.
- **Backend:** a host that allows outbound SMTP, such as Railway **Pro** or a paid Render instance. Use `backend/Dockerfile` with `PROCESS_ROLE=all`, `TRUST_PROXY=true` and `COOKIE_SECURE=true`.
- **Postgres:** Neon or Supabase (set `DATABASE_SSL=true`).
- **Redis:** Redis Cloud, or the platform's Redis with persistence enabled.
- **Elasticsearch:** Elastic Cloud (set `ELASTICSEARCH_URL` and `ELASTICSEARCH_API_KEY`).
