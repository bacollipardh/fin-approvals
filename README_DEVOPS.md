# DevOps (GitHub + GHCR) – Setup

Ky projekt ka CI/CD gati për GitHub:
- **CI** (PR + push në main): npm ci + (lint/test nëse ekzistojnë), docker compose **smoke test**, **Trivy** scan.
- **Release** (tag `vX.Y.Z`): build + push images në **GHCR**, pastaj (opsionale) deploy në server me SSH.

## 1) Krijo GitHub repo dhe shty kodin
Në root të projektit:

```bash
git init
git add .
git commit -m "chore: initial"
```

Krijo repo në GitHub (p.sh. `fin-approvals`) dhe pastaj:

```bash
git branch -M main
git remote add origin <PASTE_GITHUB_REPO_SSH_OR_HTTPS_URL>
git push -u origin main
```

## 2) Çka krijojnë workflows
- `.github/workflows/ci.yml` – CI
- `.github/workflows/release.yml` – Release + deploy

Images publikohen si:
- `ghcr.io/<owner>/<repo>-api:<tag>`
- `ghcr.io/<owner>/<repo>-web:<tag>`

## 3) Si bëhet release (versioning)
Tag dhe push:

```bash
git tag v1.0.0
git push origin v1.0.0
```

Kjo ndez workflow `Release` që:
- ndërton + push API/WEB images në GHCR (tag + latest)
- bën Trivy scan mbi API image
- (opsionale) bën deploy në server, nëse ke vendosur secrets.

## 4) Deploy në server (1 herë setup)
Në server (Ubuntu/Debian), krijo folder p.sh.:

```bash
sudo mkdir -p /opt/fin-approvals
sudo chown -R $USER:$USER /opt/fin-approvals
```

Kopjo në server këto file/folders:
- `docker-compose.deploy.yml`
- `db/init/` (opsionale)
- `secrets/` (gjenero secrets në server)
- `.env` (server env)

### 4.1 Gjenero secrets në server
Linux:

```bash
bash ./secrets/generate.sh
```

### 4.2 Krijo `.env` në server
Shembull:

```env
HTTP_PORT=80
ALLOWED_ORIGINS=https://fin.migrosks.com
APP_URL=https://fin.migrosks.com

API_IMAGE=ghcr.io/<owner>/<repo>-api:latest
WEB_IMAGE=ghcr.io/<owner>/<repo>-web:latest
```

### 4.3 Deploy manual (në server)

```bash
cd /opt/fin-approvals
docker compose -f docker-compose.deploy.yml pull
docker compose -f docker-compose.deploy.yml up -d
```

## 5) Deploy automatik nga GitHub (SSH)
Në GitHub repo → Settings → Secrets and variables → Actions → **New repository secret**:
- `PROD_HOST` (p.sh. `84.x.x.x`)
- `PROD_USER` (p.sh. `debian`)
- `PROD_SSH_KEY` (private key)
- `PROD_PATH` (p.sh. `/opt/fin-approvals`)

Kur bën tag `vX.Y.Z`, workflow do deploy.

## 6) Multi-server
Për më shumë servera, shto secrets për secilin (p.sh. `PROD2_HOST`, ... ) dhe bëjmë matrix deploy.
