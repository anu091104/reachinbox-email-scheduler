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

## Alternative: split hosting (paid tiers)

If you'd rather use managed services:

- **Frontend:** Vercel. Set the project root to `frontend/` and replace `YOUR-BACKEND-DOMAIN` in `frontend/vercel.json`. The rewrite proxies `/api` so the session cookie stays first-party.
- **Backend:** a host that allows outbound SMTP, such as Railway **Pro** or a paid Render instance. Use `backend/Dockerfile` with `PROCESS_ROLE=all`, `TRUST_PROXY=true` and `COOKIE_SECURE=true`.
- **Postgres:** Neon or Supabase (set `DATABASE_SSL=true`).
- **Redis:** Redis Cloud, or the platform's Redis with persistence enabled.
- **Elasticsearch:** Elastic Cloud (set `ELASTICSEARCH_URL` and `ELASTICSEARCH_API_KEY`).
