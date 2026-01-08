# Qubic Solana Bridge Oracle

This repository hosts the Oracle responsible for validating Solana <-> Qubic bridge transactions.

## Prerequisites

Using **Docker** is the default way to run the Oracle.

If you prefer running it directly on your machine (optional), you need:

* Node.js 24+

## Environment Configuration

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Set `SQLITE_DB_FILE` to the database path.

* **Docker (default):** `/data/oracle.sqlite3` (stored in a persistent Docker volume)
* **Local Node.js (optional):** `./data/oracle.sqlite3` inside the repository

The Oracle creates the SQLite database automatically on first launch.

## Hub Security & Key Rotation

Oracles only trust Hub-signed requests using pinned Ed25519 public keys stored on disk (`HUB_KEYS_FILE`).
The Hub exposes `GET /api/keys` for operators to retrieve current/next public keys
([qs-bridge-hub](https://github.com/avicenne-studio/qs-bridge-hub)).
Oracles should not auto-fetch keys to avoid trusting the network path at runtime
and to keep key changes as an explicit, audited operator action.

Rotation flow: update `HUB_KEYS_FILE` with the Hub's `current` and `next` keys before a rotation.
Requests include `X-Key-Id`; the oracle accepts either `current` or `next` for the given hub ID.
It is the oracle operator's responsibility to keep the pinned keys file updated.


## Development

### Run the Oracle in development mode

Run:
```bash
docker compose up --build
```

Access the API at:

```
http://localhost:3000
```

The SQLite database is stored in the `oracle-sqlite` Docker volume at `/data/oracle.sqlite3`.
Any changes to local `.ts` files reload automatically inside the container.

## Production

Use the production-optimized multi-stage image with the dedicated compose file:

```bash
docker compose -f docker-compose.prod.yml up --build -d
```

Stop the production service:

```bash
docker compose -f docker-compose.prod.yml down
```

## Node.js without Docker

Install dependencies:

```bash
npm install
```

Then run the script that pre-built for better-sqlite3:
```bash
npx allow-scripts run
```

> More info about `allow-scripts`: https://lavamoat.github.io/guides/allow-scripts/

This project uses better-sqlite3, which includes a native module that must be compiled during installation:

```bash
npm rebuild better-sqlite3 --ignore-scripts=false
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

## Testing and Coverage

Run the full test suite:

```bash
npm run test
```

## Solana Test Keypairs

Generate a new Solana CLI-style keypair file (64-byte JSON array) and print a
`SOLANA_KEYS` JSON payload (you must provide `OUT`):

```bash
OUT=.temp/solana-id.json npm run generate-solana-keypair
```

## Linting

Check lint rules:

```bash
npm run lint
```

Autofix:

```bash
npm run lint:fix
```
