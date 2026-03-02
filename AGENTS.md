# Qubic ↔ Solana Oracle – Agent Notes

## Overview
- Fastify service that participates in a replicated oracle network for the Qubic ↔ Solana bridge.
- Responsibilities: authenticate Hub requests, poll the Hub for signatures/events, persist and process events into orders, and relay ready orders on-chain.
- Entry point `src/server.ts` registers `src/app.ts`, which autoloads infra plugins, app plugins, and routes.

## Runtime Architecture
- **Infra plugins (`src/plugins/infra`)**
  - `env.ts` validates config and sanitizes key file paths via `file-manager`.
  - `@file-manager.ts` enforces JSON file paths and blocks traversal.
  - `@knex.ts` sets up SQLite + creates tables on startup.
  - `poller.ts` provides a single/fallback poller with timeout + jitter.
  - `undici-client.ts` provides pooled HTTP JSON clients for polling.
  - `helmet`, `cors`, `rate-limit`, `sensible` provide baseline security/UX.
- **App plugins (`src/plugins/app`)**
  - **Hub auth**: `hub-keys.ts` loads Hub public keys, `hub-verifier.ts` validates `X-Hub-*` headers, stores nonces in SQLite (`hub-nonces.repository.ts`), and `hub-nonces-cleaner.ts` evicts old nonces.
  - **Orders**: `indexer/orders.repository.ts` persists oracle orders + signatures.
  - **Events**: `events.service.ts` polls Hub `/api/orders/events` into `hub_events` and maintains cursors; `events-processor.ts` validates + processes pending events into orders; Solana/Qubic validators live under `events/solana` and `events/qubic`.
  - **Signer**: `signer.service.ts` loads Solana + Qubic keys and signs bridge orders.
  - **Relayer**: `relayer.ts` selects `ready-for-relay` orders and calls `relay-solana.ts` / `relay-qubic.ts` with exponential backoff + retry tracking; `relayer-fee-acceptance.ts` enforces relayer fee floors.
  - **Hub signatures polling**: `hub-signatures.service.ts` polls Hub `/api/orders/signatures`, stores signatures, and marks orders ready once `ORACLE_SIGNATURE_THRESHOLD` is met.

## Data Model (SQLite)
Tables are auto-created by `src/plugins/infra/@knex.ts`:
- `orders`: core order fields + relay state (`status`, `oracle_accept_to_relay`, `relay_attempts`, `next_relay_at`, `last_relay_error`, `failure_reason_public`).
- `order_signatures`: `(order_id, signature)` uniques for aggregated signatures.
- `hub_nonces`: `(hubId, kid, nonce, ts)` for replay protection.
- `hub_events`: persisted Hub events with retry and failure metadata.
- `hub_event_cursors`: per-Hub cursor for incremental polling.

## Event + Relay Pipeline
1. **Hub events poller** (`events.service.ts`) pulls `/api/orders/events` using cursors and stores events.
2. **Events processor** (`events-processor.ts`) validates and maps events into order updates; failures are retried up to `EVENT_MAX_RETRIES` and can create failed orders for outbound/lock events.
3. **Hub signatures poller** (`hub-signatures.service.ts`) pulls `/api/orders/signatures`, stores new signatures, and marks orders ready for relay when threshold met.
4. **Relayer** (`relayer.ts`) attempts relay for `ready-for-relay` orders and updates status with backoff and failure diagnostics.

## Routes
- `GET /` – welcome banner.
- `GET /api/health` – DB check + timestamp + relayer fee config.
- `GET /api/orders` – consensus order listing (used by Hub polling).

## Config & Ops
- Required env vars (see `src/plugins/infra/env.ts`): `HOST`, `PORT`, `SQLITE_DB_FILE`, `SOLANA_KEYS`, `QUBIC_KEYS`, `HUB_URLS`, `HUB_KEYS_FILE`, `SOLANA_RPC_URL`, `SOLANA_WS_URL`, `QUBIC_RPC_URL`, `TOKEN_MINT`, `SOLANA_TX_COMMITMENT`, `SOLANA_LOOKUP_TABLE_ADDRESS`, `RELAYER_FEE_SOLANA`, `RELAYER_FEE_QUBIC`.
- Relayer controls: `RELAYER_ENABLED`, `RELAYER_PROCESS_INTERVAL_MS`, `RELAYER_MAX_ATTEMPTS`, backoff settings.
- Events controls: `EVENT_MAX_RETRIES`, `EVENTS_LOOKBACK_DAYS`, `EVENTS_PROCESS_INTERVAL_MS`.
- Generated Solana client code lives under `src/clients/js` and should not be edited by hand.

## Testing
- Tests live in `test/` and mirror runtime folders (`app`, `plugins`, `routes`). Use `.env.test` and the shared Fastify builder in `test/helpers`.
- Avoid direct `process.env` usage in tests; rely on Fastify config and `.env.test`.
