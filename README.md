# ReachInbox Email Scheduler

A full-stack email scheduling service: an Express + TypeScript API, a BullMQ worker on Redis, PostgreSQL as the source of truth, Elasticsearch for search, Ethereal for SMTP, and a React dashboard built from the provided Figma.

Emails are scheduled as **BullMQ delayed jobs** (no cron), sent from **multiple senders** under **Redis-backed rate limits**, and keep their schedule through **server restarts** with no duplicate sends.

**Live app:** https://reachinbox-email-scheduler-lake-nine.vercel.app · **API health:** https://reachinbox-email-scheduler-v125.onrender.com/health · **Queue dashboard:** https://reachinbox-email-scheduler-v125.onrender.com/admin/queues (credentials shared on request)

**Demo video (under 5 min):** _add link here_

---

## Contents

1. [Features implemented](#features-implemented)
2. [Architecture](#architecture)
3. [How scheduling works](#how-scheduling-works)
4. [Persistence across restarts](#persistence-across-restarts)
5. [Rate limiting and concurrency](#rate-limiting-and-concurrency)
6. [Running locally](#running-locally)
7. [Ethereal setup](#ethereal-setup)
8. [Configuration reference](#configuration-reference)
9. [API reference](#api-reference)
10. [Testing](#testing)
11. [Deployment](#deployment)
12. [Project structure](#project-structure)
13. [Assumptions, shortcuts and trade-offs](#assumptions-shortcuts-and-trade-offs)

---

## Features implemented

### Backend

| Area | What's implemented | Where |
|---|---|---|
| **Scheduler** | `POST /api/campaigns` turns one Compose submission into one BullMQ **delayed job** per recipient (`delay = scheduledAt − now`, `jobId = emailId`). No cron, no polling. Email *i* is due at `startAt + i × delayBetweenSeconds`. Cancel a scheduled email (`DELETE /api/emails/:id`). | `services/campaigns.ts`, `queue/email-queue.ts` |
| **Sending** | Nodemailer over Ethereal SMTP from **multiple senders** (3 Ethereal accounts created on first boot, more via `npm run senders:create`). Pooled connection per sender. Ethereal preview URL stored per email. Attachments supported. | `services/mailer.ts` |
| **Persistence on restart** | Delayed jobs live in Redis (AOF on, `noeviction`). Postgres is the source of truth. At boot the worker re-enqueues every `scheduled` email (idempotent because `jobId = emailId`) and resets expired leases. Stalled jobs are picked up by another worker. | `queue/send-worker.ts` → `reconcileOnBoot`, `services/email-repository.ts` |
| **No duplicates** | Atomic claim `UPDATE … WHERE status='scheduled'` plus a time-limited lease (`locked_until`). An email is only ever sent by one worker, and never re-sent once `sent`. | `services/email-repository.ts` → `claimEmail` |
| **Rate limiting** | One Redis Lua script enforces: minimum gap between sends (`MIN_DELAY_BETWEEN_EMAILS_MS`, per sender or global), hourly caps (global `MAX_EMAILS_PER_HOUR`, per sender `MAX_EMAILS_PER_HOUR_PER_SENDER`, per campaign from Compose). Over-limit emails are **rescheduled into the next hour in arrival order**, never dropped. | `queue/throttle.ts` |
| **Concurrency** | `WORKER_CONCURRENCY` jobs in parallel per worker, any number of worker processes (`npm run dev:worker`). Safe because all shared state is in Postgres (row claim) or Redis (atomic Lua); no in-memory counters. | `queue/send-worker.ts` |
| **Retries** | Exponential backoff for temporary SMTP errors; permanent 5xx errors fail immediately; attempts and last error stored. | `queue/send-worker.ts` |
| **Search** | Every email indexed in **Elasticsearch** (fuzzy, highlighted, status-filtered). Falls back to Postgres if ES is down; `npm run search:reindex` rebuilds the index. | `services/search.ts` |
| **Queue dashboard** | Live **Bull Board** at `/admin/queues`, behind basic auth. | `app.ts` |
| **Auth & security** | Google sign-in (token verified server-side against `GOOGLE_CLIENT_ID`) plus email/password (bcrypt). httpOnly JWT session cookie, sanitised email HTML, helmet, login rate limit, per-user data isolation. | `routes/auth.ts`, `middleware/auth.ts` |
| **Operations** | Validated env config (zod), structured logs (pino), `/health`, graceful shutdown (in-flight sends finish), migrations on boot, Dockerfile. | `config/env.ts`, `bootstrap.ts` |

### Frontend (React 19 + TypeScript + Tailwind v4, built from the Figma)

| Area | What's implemented |
|---|---|
| **Login** | Google login button plus email/password sign-in and sign-up; session persists across reloads; protected routes. |
| **Dashboard** | Sidebar with user card (name, email, avatar, logout), Compose button, Scheduled and Sent counts. |
| **Compose** | Sender picker, recipient chips (type, paste, or **Upload List** from CSV/TXT, with the email count shown), subject, **Delay between 2 emails**, **Hourly Limit**, rich-text editor, attachments, **Send Later** picker with presets. |
| **Scheduled table** | Recipient, subject, snippet, scheduled time badge, "rate-limited" tag when moved by a limit, star, pagination. |
| **Sent table** | Recipient, subject, sent time, status (Sent / Failed). |
| **Email detail** | Status banner, Ethereal preview link, attachments, attempts, campaign settings, cancel button for scheduled emails. |
| **Search, filter, refresh** | Elasticsearch-backed search bar, starred filter, refresh; lists update automatically every 5 seconds. |
| **States** | Loading skeletons, empty states, error messages, toast notifications. |

---

## Architecture

```
            ┌────────────────────────── Browser (React dashboard) ─────────────────────────┐
            │ Login · Scheduled · Sent · Compose · Search                                   │
            └───────────────┬───────────────────────────────────────────────────────────────┘
                            │ /api/*  (same origin: Vite proxy locally, Caddy in production)
                            ▼
┌──────────────────────────────────────────────┐        ┌─────────────────────────────────┐
│ Express API (TypeScript)                      │        │ Bull Board  /admin/queues       │
│  auth · campaigns · emails · search · limits  │        └───────────────┬─────────────────┘
└───────┬───────────────┬───────────────┬───────┘                        │
        │ write rows    │ add delayed   │ index / query                  │ reads queue
        ▼               ▼ jobs          ▼                                ▼
┌──────────────┐  ┌───────────────────────────┐  ┌────────────────┐
│ PostgreSQL   │  │ Redis                      │  │ Elasticsearch  │
│ source of    │  │ BullMQ delayed set + Lua   │  │ search index   │
│ truth        │  │ rate-limit counters (AOF)  │  │ (rebuildable)  │
└──────▲───────┘  └─────────────┬─────────────┘  └───────▲────────┘
       │ claim / mark sent      │ due jobs                │ sync status
┌──────┴────────────────────────▼─────────────────────────┴────────┐
│ BullMQ Worker(s)  — concurrency N, any number of processes        │
│  claim row (lease) → throttle (Lua) → SMTP (pooled, per sender)   │
└───────────────────────────────┬───────────────────────────────────┘
                                ▼
                       Ethereal SMTP (fake inboxes)
```

The API and the worker share one codebase and can run in one process (`npm run dev`) or separately (`dev:api` / `dev:worker`). Workers coordinate only through Redis and Postgres, so you can run as many as you like.

### Data model

| Table | Purpose |
|---|---|
| `users` | Google or email/password accounts |
| `senders` | Mailboxes we can send from (one Ethereal account each) |
| `campaigns` | One Compose submission: subject, body, start time, delay, hourly limit |
| `emails` | One row per recipient: `status`, `scheduled_at`, `requested_at`, `attempts`, `deferrals`, `locked_until`, `preview_url`, … |
| `attachments` | Files stored with the campaign (bytea) so any worker on any machine can attach them |

Email status lifecycle:

```
scheduled ──claim──▶ processing ──▶ sent
    ▲                    │
    └── retry / defer ───┘──▶ failed   (permanent SMTP error, or out of attempts)
scheduled ──cancel──▶ cancelled
```

---

## How scheduling works

1. The dashboard posts the campaign (`multipart/form-data` with a JSON `payload` and optional attachments).
2. Inside **one Postgres transaction**, the API inserts the campaign and one `emails` row per recipient. Email *i* is due at
   `startAt + i × delayBetweenSeconds`, so the form's "Delay between 2 emails" is built into each email's own due time.
3. After the transaction commits, the API adds one BullMQ job per email with `delay = scheduledAt − now` and **`jobId = email.id`**.
   If Redis rejects the enqueue, the campaign is deleted and the user gets a clear 503, so no email is left in the database without a timer.
4. BullMQ keeps delayed jobs in a Redis sorted set ordered by due time. When a job is due, a worker picks it up and:
   - **claims** the row: `UPDATE emails SET status='processing', locked_until=now()+lease WHERE id=$1 AND (status='scheduled' OR lease expired)`. Only one worker can win this compare-and-set.
   - asks the **throttle** for permission (see below). If the answer is "wait" or "next hour", it releases the claim and puts the job back with `job.moveToDelayed(...)`, which does not use up a retry attempt.
   - sends through a pooled Nodemailer transport for that sender, then marks the row `sent` with the Ethereal preview URL.
5. Every state change is mirrored into Elasticsearch, so search results show live status.

---

## Persistence across restarts

| What could go wrong | What happens |
|---|---|
| The Node process restarts or crashes | Delayed jobs are in Redis, not in memory. On boot the worker picks up where it left off: future emails go out on time, and overdue ones go out immediately (still throttled). |
| Redis restarts | Redis runs with `appendonly yes` (see `docker-compose.yml`), so delayed jobs are reloaded from disk. `maxmemory-policy noeviction` stops Redis from silently dropping queue keys. |
| A crash between the DB commit and the enqueue, or the Redis data is lost | **Boot reconciliation**: on startup the worker re-adds a job for every `scheduled` row in Postgres. Because `jobId = emailId`, this does nothing for jobs that already exist, so it is safe to run every time. |
| A worker dies while sending | BullMQ notices the stalled job (its lock expires) and hands it to another worker. The Postgres lease (`locked_until`) makes the new worker wait until the old lease expires, so two workers never send the same email at once. Expired leases are also reset at boot. |
| The same job runs twice anyway | The claim only succeeds for `scheduled` rows, so a `sent` email is never sent again. |

I tested this by scheduling 6 emails 4 seconds apart and killing the server with `kill -9` after the first one had gone out. The other 5 jobs were still in Redis. As soon as the server came back, the emails that had come due during the downtime went out one after another, still spaced by the minimum gap, followed by the rest. The SMTP log showed each of the 6 exactly once.

> **Delivery guarantee:** at-least-once with a very small window. If the process dies *after* the SMTP server accepted a message but *before* Postgres recorded `sent`, that one email could be sent again after the lease expires. Each message carries a deterministic `Message-ID` (`<emailId@reachinbox-scheduler.local>`), so receiving systems can spot the duplicate. Removing that window completely would need provider-side idempotency keys.

---

## Rate limiting and concurrency

All the counters live in **Redis**, and they are checked and updated by **one Lua script** (`backend/src/queue/throttle.ts`). Redis runs a script atomically, so no matter how many workers or machines are running, two of them can never both see "49 of 50 used" and both send.

### 1. Worker concurrency
`WORKER_CONCURRENCY` (default **5**) jobs run in parallel per worker process. It's safe because:
- each email is claimed by a Postgres compare-and-set (row-level locking)
- limits are enforced atomically in Redis, never in memory
- SMTP transports are pooled per sender (2 connections each) and shared safely between jobs
- the worker keeps no other shared mutable state

### 2. Minimum delay between sends
**Chosen value: at least 2 seconds between two sends from the same sender** (`MIN_DELAY_BETWEEN_EMAILS_MS=2000`, `SEND_GAP_SCOPE=sender`). Set `SEND_GAP_SCOPE=global` to apply the gap across all senders combined.

It works like a ticket machine. Each job asks for the next free slot, which is the last slot handed out plus the gap. If the slot is now, the job sends. If the slot is in the future, the job stores the slot in its data and sleeps until then with `moveToDelayed`, without holding a concurrency slot or burning an attempt. Jobs therefore leave in the order they asked, instead of all retrying at random.

This sits on top of the per-campaign "Delay between 2 emails" from the Compose form, which spaces out the due times themselves.

### 3. Emails per hour
Three caps, all configurable and with `0` meaning unlimited:

| Cap | Source | Default |
|---|---|---|
| Global | `MAX_EMAILS_PER_HOUR` | 200 |
| Per sender | `MAX_EMAILS_PER_HOUR_PER_SENDER` | 50 |
| Per campaign | "Hourly Limit" field in Compose | none |

Counters are keyed by fixed UTC hour window and expire automatically: `rl:h:<hourWindow>:global`, `rl:h:<hourWindow>:sender:<id>`, `rl:h:<hourWindow>:campaign:<id>`.

**When a cap is full**, the job is **not dropped and not failed**. The script hands it a sequence number for the next window, and the job moves to `nextHourStart + (seq − 1) × gap`. The email's `scheduled_at` in Postgres moves forward too (and `deferrals` goes up), so the dashboard shows the real expected time and a "rate-limited" tag. Because the sequence number follows arrival order, the original order is kept as much as possible.

If an SMTP attempt fails before anything was delivered, the hourly slots are given back so a temporary outage doesn't use up the quota.

---

## Running locally

### Prerequisites
- **Node.js 20.10+** (22 LTS recommended)
- **Docker Desktop**, for Postgres, Redis and Elasticsearch
  - *Windows with a small C: drive:* in Docker Desktop, go to Settings → Resources → Advanced → **Disk image location**, choose a folder on D:, then Apply & restart.

### 1. Start the infrastructure
```bash
docker compose up -d
docker compose ps          # wait until all three show "healthy" (Elasticsearch takes ~30–60 s)
```

### 2. Backend
```bash
cd backend
cp .env.example .env       # Windows PowerShell: Copy-Item .env.example .env
#   set JWT_SECRET (and GOOGLE_CLIENT_ID if you want Google login)
npm install
npm run dev                # API + worker on http://localhost:4000
```
On the first boot the backend applies database migrations, creates the Elasticsearch index, and creates **3 Ethereal sender accounts** automatically.

### 3. Frontend
```bash
cd frontend
npm install
npm run dev                # http://localhost:5173
```
Open http://localhost:5173, sign in with Google or create an email/password account, then Compose. You can use `samples/leads.csv` as a lead list.

### Useful URLs
| URL | What |
|---|---|
| http://localhost:5173 | Dashboard |
| http://localhost:4000/admin/queues | Bull Board (user `admin`, password from `BULL_BOARD_PASSWORD`) |
| http://localhost:4000/health | Postgres / Redis / Elasticsearch status |
| https://ethereal.email/messages | Sent emails (log in with a sender's credentials) |

### Running API and workers separately
```bash
npm run dev:api            # terminal 1
npm run dev:worker         # terminal 2
npm run dev:worker         # terminal 3: a second worker; the limits still hold across both
```

---

## Ethereal setup

[Ethereal](https://ethereal.email) is a fake SMTP service. It accepts mail like a real server but never delivers it, and shows every message in a web inbox.

- **Automatic:** on first boot, `AUTO_PROVISION_SENDERS` (default 3) Ethereal accounts are created through Nodemailer's `createTestAccount()` and saved in the `senders` table.
- **Manual:** `npm run senders:create -- 2` creates 2 more and prints their usernames and passwords.
- **Viewing mail:** every sent email's detail page has a **"View on Ethereal"** link. You can also log in at https://ethereal.email/login with a sender's username and password; the `senders` table holds both.

---

## Configuration reference

All backend settings are in `backend/.env` and are validated at startup in `src/config/env.ts`. If a setting is invalid, the process refuses to start.

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | — | Postgres connection string |
| `REDIS_URL` | — | Redis connection string |
| `ELASTICSEARCH_URL` | — | Leave empty to use the Postgres search fallback |
| `JWT_SECRET` | — | At least 32 characters |
| `GOOGLE_CLIENT_ID` | — | OAuth Web client ID |
| `FRONTEND_ORIGIN` | `http://localhost:5173` | Allowed CORS origin(s), comma-separated |
| `WORKER_CONCURRENCY` | `5` | Parallel jobs per worker process |
| `MIN_DELAY_BETWEEN_EMAILS_MS` | `2000` | Minimum gap between sends |
| `SEND_GAP_SCOPE` | `sender` | `sender` or `global` |
| `MAX_EMAILS_PER_HOUR` | `200` | Global hourly cap (0 = off) |
| `MAX_EMAILS_PER_HOUR_PER_SENDER` | `50` | Per-sender hourly cap (0 = off) |
| `JOB_MAX_ATTEMPTS` | `5` | SMTP attempts before an email is marked failed |
| `JOB_BACKOFF_MS` | `30000` | Base of the exponential retry backoff |
| `SEND_LEASE_MS` | `60000` | How long a worker owns an email while sending |
| `AUTO_PROVISION_SENDERS` | `3` | Ethereal accounts to create when none exist |
| `SMTP_PORT_OVERRIDE` | — | Send through this port for every sender (e.g. `2525` on hosts that block 587) |
| `BULL_BOARD_USER` / `BULL_BOARD_PASSWORD` | `admin` / — | Queue dashboard login |

### Google sign-in
1. Go to https://console.cloud.google.com → APIs & Services → Credentials → **Create credentials → OAuth client ID → Web application**. Configure the consent screen first if prompted (External; add yourself as a test user).
2. Under **Authorized JavaScript origins**, add `http://localhost:5173` (and your production URL later).
3. Put the client ID in `backend/.env` as `GOOGLE_CLIENT_ID`. The frontend fetches it from `/api/auth/config`, so you don't need to configure it twice.

---

## API reference

All routes except auth require the session cookie.

| Method | Route | Description |
|---|---|---|
| `POST` | `/api/auth/google` | `{ accessToken }` or `{ credential }` → session |
| `POST` | `/api/auth/register` · `/api/auth/login` | Email/password |
| `POST` | `/api/auth/logout` · `GET /api/auth/me` | |
| `GET` | `/api/senders` | Available sender mailboxes |
| `POST` | `/api/campaigns` | Schedule emails (see below) |
| `GET` | `/api/emails?tab=scheduled\|sent&page=&pageSize=&starred=` | Paginated list |
| `GET` | `/api/emails/stats` | Counts per status |
| `GET` | `/api/emails/:id` | Detail + attachments |
| `PATCH` | `/api/emails/:id/star` | `{ starred: boolean }` |
| `DELETE` | `/api/emails/:id` | Cancel a scheduled email |
| `GET` | `/api/search?q=&tab=` | Elasticsearch search |
| `GET` | `/api/limits` | This hour's usage per sender |
| `GET` | `/health` | Dependency health |

`POST /api/campaigns` (`multipart/form-data`):
```jsonc
// field "payload" (JSON string)
{
  "senderId": "uuid",
  "recipients": ["a@x.com", "b@y.com"],   // 1–10,000, deduplicated and validated
  "subject": "Quick intro",
  "bodyHtml": "<p>Hello</p>",              // sanitised on the server
  "startAt": "2026-11-01T10:00:00.000Z",
  "delayBetweenSeconds": 5,
  "hourlyLimit": 40                          // 0 = no campaign limit
}
// field "attachments": up to 5 files, 5 MB each
```
Response `201`: `{ id, scheduled, firstSendAt, lastSendAt }`

---

## Testing

```bash
cd backend
npm test            # needs Redis on localhost:6379 (docker compose up -d redis)
npm run typecheck
```
The rate-limiter tests run against a real Redis. They check slot spacing, per-sender independence, deferral into the next hour in arrival order, the global and campaign caps, **50 concurrent callers never exceeding a cap of 10**, and giving slots back on failure.

### Manual restart test (also worth showing in the demo)
1. Compose 5 emails with a 20-second delay between them.
2. Once the first one has sent, stop the backend (`Ctrl + C`).
3. Wait about 30 seconds, then run `npm run dev` again.
4. The emails that came due while the server was down go out right away; the rest go out on schedule. The Sent tab shows each email exactly once.

---

## Deployment

The live deployment uses only free tiers:

| Piece | Where |
|---|---|
| Frontend (React) | Vercel: `/api/*` is rewritten to the backend, so the session cookie stays first-party |
| API (Express) | Render web service, `PROCESS_ROLE=api` |
| BullMQ worker | Separate process (`npm run dev:worker`) on a machine with outbound SMTP |
| PostgreSQL | Neon |
| Redis | Redis Cloud |
| Elasticsearch | Elastic Cloud |

**Why the worker runs separately:** Render's free tier blocks outbound SMTP ports (25, 465, 587, and in practice 2525), so Ethereal can't be reached from it. Because API and workers coordinate only through Redis and Postgres, the worker can run anywhere with SMTP access; this is also how workers are scaled independently of the API. On a host that allows SMTP (any VM, or a paid Render instance), set `PROCESS_ROLE=all` and the single service does both.

**Google sign-in:** the OAuth app is in Testing mode, so only listed test users can use Google login. Reviewers can sign up with email and password, or share a Gmail address to be added as a test user.

Step-by-step guides for both the free setup and a single-VM Docker setup are in **[DEPLOYMENT.md](DEPLOYMENT.md)**.

---

## Project structure

```
├── docker-compose.yml          # local Postgres + Redis (AOF) + Elasticsearch
├── docker-compose.prod.yml     # full stack for a single VM
├── deploy/                     # VM setup script, production env template
├── samples/leads.csv           # example lead list for "Upload List"
├── backend/
│   ├── drizzle/                # SQL migrations (applied automatically on boot)
│   ├── src/
│   │   ├── config/env.ts       # validated configuration
│   │   ├── db/                 # schema, client, migrator
│   │   ├── queue/
│   │   │   ├── email-queue.ts  # Queue + enqueue (jobId = emailId)
│   │   │   ├── send-worker.ts  # job processor, retries, boot reconciliation
│   │   │   └── throttle.ts     # Redis Lua: send slots + hourly caps
│   │   ├── services/           # campaigns, email state transitions, mailer, search
│   │   ├── routes/             # auth, emails/campaigns/search
│   │   ├── middleware/         # session auth, error handling
│   │   ├── app.ts              # Express app + Bull Board
│   │   └── bootstrap.ts        # start as api | worker | all, graceful shutdown
│   └── tests/throttle.test.ts
└── frontend/
    └── src/
        ├── pages/              # Login, Mailbox (Scheduled/Sent), EmailDetail, Compose
        ├── components/         # Sidebar, EmailRow, StatusBadge, RichTextEditor, SendLaterPopover, …
        ├── hooks/              # auth context, React Query hooks
        └── lib/                # API client, lead-file parsing, formatting
```

---

## Assumptions, shortcuts and trade-offs

**Assumptions**
- **Senders are a shared pool.** Every signed-in user can send from any configured Ethereal sender, like an organisation's connected mailboxes. Per-user sender ownership would be a small schema change.
- **"Delay between 2 emails" spaces the due times** (`startAt + i × delay`). The minimum send gap (2 s) is a separate, system-wide safety rule enforced by the worker.
- **Hourly limits use fixed UTC clock hours** (10:00–10:59, 11:00–11:59, …).
- **Hourly Limit = 0** in Compose means no campaign-specific limit; the global and per-sender limits still apply.
- **Overdue emails are sent on recovery.** If the server was down when an email was due, it goes out as soon as the server is back (still throttled), rather than being skipped.
- **Email/password login was added beside Google**, because the Figma login screen shows both.

**Shortcuts**
- Attachments are stored in Postgres (`bytea`, 5 files × 5 MB) so workers stay stateless; at scale they would move to object storage (S3).
- The worker and API run in one process by default (`npm run dev`); separate processes are supported (`dev:api`, `dev:worker`) but not required.
- Google OAuth runs in "Testing" mode, so only listed test users can sign in with Google.
- Personalisation tokens (`{{first_name}}`) are not implemented, although the CSV parser already reads full rows.

**Trade-offs**
- **At-least-once delivery.** A crash after SMTP accepted an email but before Postgres recorded `sent` can cause one duplicate. A deterministic `Message-ID` lets receivers detect it; removing the window entirely needs provider-side idempotency.
- **Fixed windows can burst at the boundary** (up to 2× the cap within a few minutes either side of the hour). A sliding-window log in a Redis sorted set would smooth this, at more Redis cost.
- **Elasticsearch is a secondary index.** Writes to it are best-effort and never block sending; Postgres stays the source of truth, and the index can be rebuilt.
- **Free-tier deployment splits API and worker.** Render's free tier blocks outbound SMTP and sleeps when idle, so the API runs there (`PROCESS_ROLE=api`) and the worker runs as a separate process with SMTP access. A single VM running `docker-compose.prod.yml` avoids the split. See `DEPLOYMENT.md`.

**Next steps:** sliding-window limiter, personalisation from CSV columns, per-tenant limits, Prometheus metrics (queue depth, send latency, deferrals).
