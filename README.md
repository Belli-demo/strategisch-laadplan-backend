# Belli Laadkaart – Backend API

Express + PostgreSQL API voor gemeente-persistentie.

## Endpoints

| Method | Route                         | Omschrijving                    |
|--------|-------------------------------|----------------------------------|
| GET    | /health                       | Health check                    |
| GET    | /gemeenten                    | Alle gemeenten (zonder wijken)  |
| GET    | /gemeenten/:id                | Gemeente + alle wijken          |
| POST   | /gemeenten                    | Nieuwe gemeente aanmaken        |
| PUT    | /gemeenten/:id                | Gemeente volledig bijwerken     |
| PATCH  | /gemeenten/:id                | Gemeente gedeeltelijk bijwerken |
| DELETE | /gemeenten/:id                | Gemeente verwijderen            |
| GET    | /gemeenten/:id/wijken         | Wijken van gemeente             |
| PATCH  | /gemeenten/:gid/wijken/:wid   | Wijk bijwerken                  |
| GET    | /stats                        | Gebruiksstatistieken            |

## Deploy op Railway

### Stap 1 – PostgreSQL database
1. Railway dashboard → New → Database → Add PostgreSQL
2. Kopieer de `DATABASE_URL` uit het Variables tabblad

### Stap 2 – Backend service
1. New Service → Deploy from GitHub repo (deze map)
2. Environment variables:
   - `DATABASE_URL` = waarde uit stap 1
   - `NODE_ENV` = production
   - `FRONTEND_URL` = URL van je frontend (bijv. https://belli-laadkaart.up.railway.app)
3. Railway detecteert Dockerfile automatisch

### Stap 3 – Frontend koppelen
Stel in de frontend `.env` in:
```
REACT_APP_API_URL=https://jouw-backend.up.railway.app
```

## Lokaal draaien
```bash
cp .env.example .env
# Vul DATABASE_URL in
npm install
npm run dev
```
