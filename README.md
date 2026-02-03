# Fin Approvals
MVP: Postgres + Node/Express + React/Tailwind + JWT role-based approvals.

## Run
1) Start DB
```bash
docker compose up -d
```
2) Server
```bash
cd server && npm i
cp .env.example .env
node seed.js
npm run dev
```
3) Client
```bash
cd ../client && npm i
npm run dev
```
Login users:
- admin@local / admin123
- lead@local / lead123
- div@local  / div123
- dir@local  / dir123
- agent@local / agent123
