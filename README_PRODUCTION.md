# Fin Approvals — Production (Docker, no Caddy)

This package runs **Web (Nginx)** + **API (Node/Express)** + **Postgres** using Docker Compose.

## 1) Prerequisites
- Docker + Docker Compose
- A public domain is optional (this setup serves HTTP only). If you want HTTPS, terminate TLS in front of this stack (e.g. your existing Nginx/HAProxy/Cloudflare).

## 2) Generate secrets
### Windows (PowerShell)
```powershell
./secrets/generate.ps1
```

### Linux
```bash
bash ./secrets/generate.sh
```

## 3) Configure environment
Copy `.env.example` to `.env` and set at least:
- `ALLOWED_ORIGINS` to your domain
- `APP_URL` to your site

Example:
```env
HTTP_PORT=80
ALLOWED_ORIGINS=https://fin.migrosks.com
APP_URL=https://fin.migrosks.com
PUBLIC_API_URL=https://fin.migrosks.com
```

## 4) Start
```bash
docker compose up -d --build
```

- Web: `http://SERVER_IP/`
- API: `http://SERVER_IP/api/` (proxied)

## 5) Database init & migrations
- The first boot imports `db/init/001_fin_db.sql.gz` automatically.
- API runs migrations automatically (`RUN_MIGRATIONS=true`).

## 6) Idempotency-Key (enterprise retries)
When creating a request, send header:
- `Idempotency-Key: <random-unique-string>`

If a client retries the same request with the same key, the API returns the existing request (no duplicates).
