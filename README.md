# Qubic Solana Bridge Oracle

This repository hosts the Oracle responsible for validating Solana <-> Qubic bridge transactions.

## Prerequisites

For most users, **Docker** is the recommended and default way to run the Oracle.

If you prefer running it directly on your machine (optional), you need:

* Node.js 24+

---

## Environment Configuration

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Set `SQLITE_DB_FILE` to the database path.

* **Docker (default):** `/data/oracle.sqlite3` (stored in a persistent Docker volume)
* **Local Node.js (optional):** `./data/oracle.sqlite3` inside the repository

The Oracle creates the SQLite database automatically on first launch.

---

# Development Workflow (Docker-first)

## Run the Oracle in development mode

This uses `docker-compose.yml`, mounts the local source tree, and runs the service with hot reload:

```bash
docker compose up --build
```

Access the API at:

```
http://localhost:3000
```

The SQLite database is stored in the `oracle-sqlite` Docker volume at `/data/oracle.sqlite3`.
Any changes to local `.ts` files reload automatically inside the container.

---

# Production Workflow

Use the production-optimized multi-stage image with the dedicated compose file:

```bash
docker compose -f docker-compose.prod.yml up --build -d
```

Stop the production service:

```bash
docker compose -f docker-compose.prod.yml down
```

This mode:

* uses the optimized production Dockerfile
* runs with `NODE_ENV=production`
* persists the SQLite DB via a Docker volume
* exposes port `3000`

---

# Optional: Local Node.js Execution (without Docker)

Install dependencies:

```bash
npm install
```

Build TypeScript sources:

```bash
npm run build
```

Run with hot reload:

```bash
npm run dev
```

Run the production server:

```bash
npm start
```

Run the standalone binary (see `src/server.ts`):

```bash
npm run standalone
```

---

# Testing and Coverage

Run the full test suite:

```bash
npm run test
```

---

# Linting

Check lint rules:

```bash
npm run lint
```

Autofix:

```bash
npm run lint:fix
```

---

# Contributing

Contributions, bug reports, and pull requests are welcome.
Please describe your use case and include tests to maintain full coverage.
