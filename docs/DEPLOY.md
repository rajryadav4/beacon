# Deploying Beacon (free)

Beacon runs as one Docker image (`Dockerfile`): FastAPI serves the API under `/api` and the built web app on
the same origin. Everything below is free tier or open source.

| Piece | Where | Config in the repo |
|---|---|---|
| App (API + web) | Render free web service | `Dockerfile`, `render.yaml` |
| Database | Neon free Postgres with PostGIS (Supabase free also works) | `pipeline/publish_db.py` |
| Fresh alerts, safe places | GitHub Actions schedule | `.github/workflows/refresh-data.yml` |
| Tests | GitHub Actions | `.github/workflows/ci.yml` |

You need the local database loaded first (docs/DEVELOPMENT.md): the hosted database is filled from it.

## 1. Neon: create the database

1. Go to https://neon.com and sign up with GitHub.
2. Create a project: name `beacon`, region **AWS US West 2 (Oregon)** (next to Render's Oregon region).
3. Open **SQL Editor** and run:
   ```sql
   CREATE EXTENSION IF NOT EXISTS postgis;
   ```
   (`publish_db.py` does this too; running it here confirms PostGIS is available.)
4. Click **Connect**, keep branch `main`, database `neondb`, role `neondb_owner`, turn **Connection pooling off**,
   and copy the connection string (`postgresql://neondb_owner:...@ep-....us-west-2.aws.neon.tech/neondb?sslmode=require...`).
   This string is a password: keep it out of the repo, chats and screenshots.

## 2. Copy the data to Neon (on your Mac)

Start the local database (`docker compose up -d db`), then from the repository root:

```bash
read -s TARGET_DATABASE_URL && export TARGET_DATABASE_URL
```

Paste the Neon string and press Enter (nothing is shown, and it does not go into your shell history).

```bash
.venv/bin/python pipeline/publish_db.py
```

It creates PostGIS and the schema, then copies only the tables the API reads (lookups, grid, crime summaries,
the risk model, safe places, alerts, hazard outlook tables when present) and prints row counts and the database
size (about 30 MB; about 100 MB with the hazard zones). The 300k crime incidents stay local. Run it again any time
you reload local data: it replaces the copied tables. Add `--no-live` to leave the hosted alerts alone.

## 3. Render: deploy the app

1. Go to https://dashboard.render.com and sign in with GitHub.
2. **New** > **Blueprint**. Connect your GitHub account if asked and allow access to `rajryadav4/beacon`.
3. Select the repository. Render reads `render.yaml` and shows one service, `beacon` (Docker, Free).
4. Paste the Neon connection string into **DATABASE_URL** and click **Deploy Blueprint**.
5. Wait for the first build (a few minutes). The service page shows the URL, `https://beacon-....onrender.com`.
   Open it, and `.../api/health` should say `{"status": "ok", "database": "ok"}`.

Every push to `main` redeploys. To change the database later: service > **Environment** > edit `DATABASE_URL`
(Render only asks for `sync: false` values when the Blueprint is first created).

## 4. GitHub: keep alerts fresh

1. Repository **Settings** > **Secrets and variables** > **Actions** > **New repository secret**.
2. Name `DATABASE_URL`, value: the same Neon string. **Add secret**.
3. **Actions** tab > **Refresh data** > **Run workflow** to test it once.

It then runs every 15 minutes (alerts and Seattle Fire calls, and the hazard outlook once
`pipeline/outlook_worker.py` exists) and daily (safe places). Without the secret it does nothing. GitHub can start
scheduled runs late, and pauses schedules after 60 days without commits: re-enable them on the Actions tab.

## 5. Share it

Send the `onrender.com` URL. If nobody has used it for 15 minutes, the first visit waits about a minute while
Render starts the service; say so when you share it ("give it a minute to wake up").

## Free tier limits (checked 2026-11-19; check current limits before relying on them)

- **Render free web service**: 512 MB RAM, 0.1 CPU. Sleeps after 15 minutes without inbound traffic; waking takes
  about a minute. 750 free instance hours per workspace per month (one service running all month fits). Render
  may restart it at any time. Outbound bandwidth counts against the workspace's monthly allowance (amount: check
  current limits); responses are gzipped to save it.
- **Neon free**: storage per project is limited (the plans page listed 1 GB; check current limits), 100 CU-hours of
  compute per project per month, compute scales to zero after 5 minutes idle and wakes in a few hundred ms, 5 GB of
  network transfer per month. A full map load reads about 1.5 MB from the database, so 5 GB is a few thousand map
  loads a month. The refresh job wakes the database every 15 minutes; if Neon warns about compute hours, change
  `*/15` to `*/30` in `.github/workflows/refresh-data.yml`.
- **GitHub Actions**: free for public repositories.

### Supabase instead of Neon

Create a free project, enable **postgis** under **Database** > **Extensions**, and use the **Session pooler**
connection string (the direct one is IPv6-only, which Render and GitHub Actions cannot reach). Steps 2-4 are the same.

## Quick share without any account

Runs on your Mac, only while it is on, with a new random URL each time:

```bash
docker build -t beacon .
```

```bash
docker run --rm -p 8000:8000 -e DATABASE_URL=postgresql://beacon:beacon-dev@host.docker.internal:5433/beacon beacon
```

In a second terminal (`brew install cloudflared` once):

```bash
cloudflared tunnel --url http://localhost:8000
```

It prints a `https://....trycloudflare.com` link to share. Ctrl+C stops it.

## Notes

- The image honours `PORT` (default 8000), runs as a non-root user, and serves `apps/web/dist` (`WEB_DIST`).
  The hazard classifier (`ml/hazard/output/`, git-ignored) is included only if it exists at build time; Render
  builds from GitHub, so the hosted app runs without it unless the model is published another way.
- `DATABASE_URL` is never committed: Render and GitHub keep it as secrets, and `publish_db.py` reads it from the
  environment and never prints it.
