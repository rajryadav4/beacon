# syntax=docker/dockerfile:1
# Beacon in one image: the FastAPI app also serves the built web app, so the
# browser calls relative /api/... on the same origin (no CORS).
#
#   docker build -t beacon .
#   docker run --rm -p 8000:8000 -e DATABASE_URL=postgresql://... beacon
#
# PORT (default 8000) is honoured, as Render and similar hosts require.
# See docs/DEPLOY.md.

# ---- Web app: React + Vite -> apps/web/dist ---------------------------------
FROM node:24-slim AS web
WORKDIR /src/apps/web
COPY apps/web/package.json apps/web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY apps/web/ ./
RUN npm run build

# ---- API: FastAPI + uvicorn ---------------------------------------------------
FROM python:3.12-slim AS api
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /app

COPY apps/api/requirements.txt apps/api/requirements.txt
RUN pip install -r apps/api/requirements.txt

# Same layout as the repository, so the app finds ml/hazard/output by default.
COPY apps/api/app apps/api/app
# The hazard classifier only if it was trained before the build (the wildcard
# matches nothing otherwise and the app runs without it).
COPY m[l]/hazar[d]/outpu[t] ml/hazard/output/
COPY --from=web /src/apps/web/dist apps/web/dist

RUN useradd --create-home --uid 10001 beacon
USER beacon

ENV WEB_DIST=/app/apps/web/dist \
    PORT=8000
EXPOSE 8000
CMD ["sh", "-c", "exec uvicorn app.main:app --app-dir apps/api --host 0.0.0.0 --port \"$PORT\" --proxy-headers --forwarded-allow-ips '*'"]
