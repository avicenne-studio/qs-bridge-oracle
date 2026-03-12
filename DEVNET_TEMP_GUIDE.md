# Devnet .temp Quickstart

This is the shortest path to add oracles and submit an inbound order on devnet using the `.temp` files.

## 1) Generate 6 oracle keypairs (Solana)

```bash
# mkdir -p .temp
# for i in 1 2 3 4 5 6; do
#   OUT=.temp/oracle-${i}.json node scripts/generate-solana-keypair.js > .temp/oracle-${i}.keys.json
#   echo "oracle-${i} generated"
# done
```

## 1b) Generate 6 oracle Qubic keys

Each oracle needs a Qubic identity (55-char seed, publicId) for future Qubic signing. Same layout as Solana: one keys file per oracle.

```bash
# for i in 1 2 3 4 5 6; do
#   OUT=.temp/oracle-${i}.qubic.json node scripts/generate-qubic-keys.js > .temp/oracle-${i}.qubic.keys.json
#   echo "oracle-${i} qubic keys generated"
# done
```

- `oracle-N.qubic.keys.json`: `pKey` = Qubic public ID, `sKey` = 55-char seed (same format as `SignerKeysSchema`).
- Optional backup: `OUT=.temp/oracle-N.qubic.json` writes the seed to a file.
- In `.env.local`, set `QUBIC_KEYS` to the path for that oracle (e.g. `.temp/oracle-1.qubic.keys.json`).

## 2) Bundle oracle keys

```bash
# node <<'NODE'
# const fs = require('fs');
# const files = [1,2,3,4,5,6].map(i => `.temp/oracle-${i}.json`);
# const data = files.map(f => JSON.parse(fs.readFileSync(f, 'utf8')));
# fs.writeFileSync('.temp/oracle-keys.json', JSON.stringify(data, null, 2));
# NODE
```


## 3) Add the 6 oracles on-chain

```bash
# for i in 1 2 3 4 5 6; do
#   PUB=$(node -e "console.log(JSON.parse(require('fs').readFileSync('.temp/oracle-${i}.keys.json','utf8')).pKey)")
#   npm run add-oracle -- "$PUB"
# done
```


## 4) Create the Address Lookup Table

The inbound relay transaction exceeds the legacy 1232-byte limit. An Address Lookup Table (ALT) compresses account addresses into 1-byte indices. The script reads `SOLANA_RPC_URL` and `TOKEN_MINT` from `.env.local`, detects registered oracles on-chain automatically, and creates + extends the LUT in a single transaction.

```bash
npm run create-lookup-table
```

Copy the printed address into `.env.local`:

```
SOLANA_LOOKUP_TABLE_ADDRESS=<address from output>
```

Note: if you add/remove oracles later, you need to create a new lookup table.

## 5) Create/Override `.temp/order.json`

```bash
node <<'NODE'
const fs = require('fs');
const { randomBytes } = require('crypto');
const order = {
  networkIn: 1,
  networkOut: 2,
  tokenIn: '0x' + '11'.repeat(32),
  fromAddress: '0x' + '22'.repeat(32),
  // Add an address you possess
  toAddress: '46F9i1Bzv8kwShyG8xbtdkA7nEoYmzyueKwjXyDgtAQV',
  amount: '1000000',
  relayerFee: '1000',
  nonce: '0x' + randomBytes(32).toString('hex'),
  recipient: '46F9i1Bzv8kwShyG8xbtdkA7nEoYmzyueKwjXyDgtAQV',
  protocolName: 'QubicBridge',
  protocolVersion: '1',
};
fs.writeFileSync('.temp/order.json', JSON.stringify(order, null, 2));
NODE
```

## 6) Send an inbound order

```bash
npm run send-inbound-order -- .temp/order.json .temp/oracle-keys.json .temp/oracle-1.json
```

Notes:
- With 6 oracles on-chain, the script signs with 60% (4) by default.
- You can override the signature count: `SIGNATURE_COUNT=4 npm run send-inbound-order -- ...`
- The script will create missing recipient/relayer ATAs automatically.

## 7) Send an outbound order (unlock/burn)

Create a minimal outbound order payload (Qubic destination uses 32-byte hex):

```bash
node <<'NODE'
const fs = require('fs');
const { randomBytes } = require('crypto');
const order = {
  networkOut: 1, // Qubic
  tokenOut: "0x" + "00".repeat(32), // Qubic token address (hex)
  toAddress: '0x' + '44'.repeat(32), // Qubic destination (hex)
  amount: '500000', // in token base units
  relayerFee: '1000',
  nonce: '0x' + randomBytes(32).toString('hex'),
};
fs.writeFileSync('.temp/outbound-order.json', JSON.stringify(order, null, 2));
NODE
```

Then send (user signs with the key that received tokens):

```bash
npm run send-outbound-order -- .temp/outbound-order.json .temp/recipient.json
```

Override an existing outbound order (update relayer fee and/or destination):

```bash
npm run override-outbound-order -- .temp/outbound-order.json .temp/recipient.json \
  --relayer-fee 2000 \
  --to-address 0x5555444444444444444444444444444444444444444444444444444444444444
```

## 8) Fake Qubic smart contract (local simulation)

The fake Qubic contract runs a local Fastify server with:
- `POST /lock`
- `POST /override-lock`
- `POST /unlock`
- `GET /events`
- `GET /transactions/:trxHash`

Start it:

```bash
# default: http://127.0.0.1:3015
npm run fake-qubic
```

Optional overrides:

```bash
FAKE_QUBIC_HOST=0.0.0.0 FAKE_QUBIC_PORT=3015 npm run fake-qubic
```

### Lock (Qubic -> Solana)

```bash
npm run lock -- \
  --from "ABCDEFGHIJKLMNOPQRSTUVWXABCDEFGHIJKLMNOPQRSTUVWX" \
  --to "46F9i1Bzv8kwShyG8xbtdkA7nEoYmzyueKwjXyDgtAQV" \
  --amount 1000000 \
  --relayerFee 1000 \
  --nonce 42
```

### Override lock

```bash
npm run override-lock -- \
  --to "0xdef" \
  --relayerFee 500 \
  --nonce 42
```

Point the scripts to a non-default server:

```bash
FAKE_QUBIC_URL=http://127.0.0.1:3015 npm run lock -- --from "id(1,2,3,4)" --to "0xabc" --amount 1000 --relayerFee 10 --nonce 1
FAKE_QUBIC_URL=http://127.0.0.1:3015 npm run override-lock -- --to "0xdef" --relayerFee 5 --nonce 1
```

## 9) Claim protocol fee (protocol fee recipient only)

```bash
npm run claim-protocol-fee -- .temp/protocol-fee-recipient.json
```

Note: this claims **protocol fee**, not oracle claimable balances.

## 10) Re-run with a new nonce

Inbound orders are one-time per nonce. To submit a new one, update the nonce:

```bash
node <<'NODE'
const fs = require('fs');
const { randomBytes } = require('crypto');
const order = JSON.parse(fs.readFileSync('.temp/order.json','utf8'));
order.nonce = '0x' + randomBytes(32).toString('hex');
fs.writeFileSync('.temp/order.json', JSON.stringify(order, null, 2));
NODE
```

## Optional env overrides

```bash
export SOLANA_RPC_URL=https://api.devnet.solana.com
export SOLANA_WS_URL=wss://api.devnet.solana.com
```

## Funding accounts (devnet)

The relayer and recipient addresses must exist (have a system account) before ATAs can be created. You can airdrop SOL to either an address or a keypair JSON:

```bash
npm run airdrop-solana -- .temp/oracle-1.json
npm run airdrop-solana -- .temp/recipient.json
```

Default amount is 1 SOL (1_000_000_000 lamports). Override by passing lamports:

```bash
npm run airdrop-solana -- .temp/recipient.json 10000000
```

## Notes
- `scripts/send-inbound-order.js` uses the token mint from global state, so `order.json` stays minimal.
- Ensure the relayer key has devnet SOL for fees.

---

## Real Qubic Smart Contract — Testnet Scripts

The scripts below target the **real Qubic SC at contract index 24** on testnet. They live in `oracle/scripts/qubic/` and are run directly with Node from the `oracle/` root.

### Prerequisites

Install dependencies from `oracle/`:

```bash
npm install
```

#### RPC node

The testnet node exposes its API under the `/live/v1/` prefix:

| Endpoint | Description |
|---|---|
| `GET /live/v1/tick-info` | Current tick and epoch |
| `POST /live/v1/broadcast-transaction` | Broadcast a signed transaction |
| `POST /live/v1/querySmartContract` | Read contract state |

`broadcastTransaction` body: `{ "encodedTransaction": "<base64>" }` — returns `{ "peersBroadcasted": N, "transactionId": "..." }`.

`querySmartContract` body: `{ "contractIndex": 24, "inputType": N, "inputSize": N, "requestData": "<base64>" }` — returns `{ "responseData": "<base64>" }`.

> **Note — Bob Node (`http://34.155.44.160:40420`) is connected to mainnet, not testnet.** Do not use it for broadcasts or queries when working with the testnet SC.

#### Environment variables

| Variable | Default | Description |
|---|---|---|
| `QUBIC_RPC_URL` | `http://95.216.34.251:41841` | Qubic testnet node |
| `QUBIC_CONTRACT_INDEX` | `24` | Smart contract index |
| `QUBIC_CONTRACT_ADDRESS` | `YAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA` | SC identity (deterministic from index 24) |
| `QUBIC_ADMIN_SEED` | — | 55-char admin seed |
| `QUBIC_TICK_OFFSET` | `10` | Ticks in the future to target |

#### Confirmed contract details

- **Contract index**: 24
- **Contract address**: `YAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`
- **Admin public key**: `SINUBYSBZKBSVEFQDZBQWUEJWRXCXOZNKPHIXDZWRBKXDSPJEHFAMBACXHUN` (see `.temp/qubic-admin.json`)
- **Oracle seeds**: `.temp/oracle-qubic-keys.json` (6 seeds)
- **K12 + SchnorrQ**: `@qubic-lib/qubic-ts-library/dist/crypto/index.js` (CommonJS, returns a Promise)

#### Confirmed struct layouts

**GetLockedOrder response** — 168 bytes:
```
exists(8/u64) | sender(32) | amount(8) | relayerFee(8) |
networkOut(4) | nonce(4) | toAddress(64) | orderHash(32) |
lockEpoch(4/epoch number) | active(4/u32)
```

**LockInput** — 88 bytes:
```
amount(8) | relayerFee(8) | toAddress(64) | networkOut(4) | nonce(4)
```

#### Remaining blockers

| ID | What's missing |
|---|---|
| **S1** | Response layouts for get-config, get-oracles, is-order-filled, UnlockInput |

---

### A) Key generation

Generate a new Qubic key pair (seed → publicId):

```bash
node scripts/qubic/generate-keys.js
```

Write result to a file:

```bash
# OUT=.temp/oracle-1.qubic.json node scripts/qubic/generate-keys.js
```

Output format: `{ "pKey": "<publicId>", "sKey": "<55-char-seed>" }`

---

### B) Read contract state

#### Get contract config (function 1)

```bash
node scripts/qubic/get-config.js
```

> ⚠️ **Blocked: S1** — response layout unconfirmed.

#### List registered oracles (function 7)

```bash
node scripts/qubic/get-oracles.js
```

> ⚠️ **Blocked: S1** — response assumed as `count(4) + accounts[64×32B]`; confirm with Seeker.

#### Query a locked order by nonce (function 4) ✅

```bash
node scripts/qubic/get-locked-order.js --nonce 1
```

Returns confirmed fields: `exists`, `sender`, `amount`, `relayerFee`, `networkOut`, `nonce`, `toAddress`, `orderHash`, `lockEpoch`, `active`.

#### Check replay protection (function 5)

```bash
node scripts/qubic/is-order-filled.js --hash <64-char-hex>
```

> ⚠️ **Blocked: S1** — response layout unconfirmed.

---

### C) Admin operations

Admin credentials are in `.temp/qubic-admin.json`:
- `pKey`: `SINUBYSBZKBSVEFQDZBQWUEJWRXCXOZNKPHIXDZWRBKXDSPJEHFAMBACXHUN`
- `sKey`: see `.temp/qubic-admin.json`

#### Register an oracle (procedure 12)

```bash
QUBIC_ADMIN_SEED=eraaastggldisjhoojaekgyimrsddjxbvgaawswfvnvaygqmusnkevv \
node scripts/qubic/add-oracle.js <oraclePublicId>
```

#### Remove an oracle (procedure 13)

```bash
QUBIC_ADMIN_SEED=eraaastggldisjhoojaekgyimrsddjxbvgaawswfvnvaygqmusnkevv \
node scripts/qubic/remove-oracle.js <oraclePublicId>
```

#### Transfer admin role (procedure 10)

```bash
QUBIC_ADMIN_SEED=eraaastggldisjhoojaekgyimrsddjxbvgaawswfvnvaygqmusnkevv \
node scripts/qubic/transfer-admin.js <newAdminPublicId>
```

> ⚠️ **WARNING** — `transfer-admin` is irreversible. Double-check the public ID before running.

---

### D) Lock flow (Qubic → Solana) ✅

Lock has been tested end-to-end on testnet. The `amount` is attached as `invocationReward` — tokens leave the sender's account immediately.

#### 1. Submit a Lock (procedure 1)

```bash
node scripts/qubic/lock.js \
  --from eraaastggldisjhoojaekgyimrsddjxbvgaawswfvnvaygqmusnkevv \
  --to 11111111111111111111111111111111 \
  --amount 1000 \
  --relayer-fee 10 \
  --nonce 1 \
  --network-out 1
```

- `--from`: 55-char Qubic seed (sender pays `amount` as invocation reward)
- `--to`: Solana base58 address (32 bytes) — zero-padded to 64 bytes internally
- `--nonce`: uint32, must be unique per sender
- `--network-out`: `1` = Solana

On success prints `transactionId`. Confirm with:

```bash
node scripts/qubic/get-locked-order.js --nonce 1
```

Expected output (nonce 1, locked by admin key):
```json
{
  "exists": true,
  "amount": "1000",
  "relayerFee": "10",
  "networkOut": 1,
  "nonce": 1,
  "lockEpoch": 206,
  "active": true
}
```

#### 2. Override an existing lock (procedure 2)

```bash
node scripts/qubic/override-lock.js \
  --from eraaastggldisjhoojaekgyimrsddjxbvgaawswfvnvaygqmusnkevv \
  --nonce 1 \
  --to 11111111111111111111111111111111 \
  --relayer-fee 5
```

#### 3. Cancel a lock (procedure 4)

```bash
node scripts/qubic/cancel-lock.js \
  --from eraaastggldisjhoojaekgyimrsddjxbvgaawswfvnvaygqmusnkevv \
  --nonce 1
```

---

### E) Unlock / relay (oracle relayer — procedure 3)

Use `relay-unlock.js` — mirrors `send-inbound-order.js` on the Solana side.

Oracle keys are in `.temp/oracle-qubic-keys.json` (array of 6 seeds).

#### qubic-order.json shape

```json
{
  "fromAddress": "<qubicPublicId or 64-char hex>",
  "toAddress":   "<solanaBase58 or 64-char hex>",
  "amount":      "1000",
  "relayerFee":  "10",
  "networkOut":  1,
  "nonce":       1,
  "tokenIn":     "0",
  "tokenOut":    "0",
  "networkIn":   0,
  "destinationChainId": 1
}
```

Notes:
- `fromAddress` is the **lock sender**; you can paste the `sender` from `get-locked-order` as 64-char hex.
- `toAddress` can be Solana base58 or 64-char hex. The Solana system program address
  `11111111111111111111111111111111` decodes to all-zero bytes, so don’t use it as a destination.

#### Create `.temp/qubic-order.json` from a locked order

```bash
node <<'NODE'
const fs = require('fs');
const order = {
  fromAddress: '11111111111111111111111111111111',
  toAddress: '46F9i1Bzv8kwShyG8xbtdkA7nEoYmzyueKwjXyDgtAQV', // your Solana address
  amount: '1000',
  relayerFee: '5',
  networkOut: 1,
  nonce: 2,
  tokenIn: '0',
  tokenOut: '0',
  networkIn: 0,
  destinationChainId: 1
};
fs.writeFileSync('.temp/qubic-order.json', JSON.stringify(order, null, 2));
console.log('Wrote .temp/qubic-order.json');
NODE
```

#### Run

```bash
node scripts/qubic/relay-unlock.js \
  .temp/qubic-order.json \
  .temp/oracle-qubic-keys.json \
  .temp/qubic-admin.json
```

Dry-run (sign + encode but skip broadcast):

```bash
DRY_RUN=1 node scripts/qubic/relay-unlock.js \
  .temp/qubic-order.json \
  .temp/oracle-qubic-keys.json \
  .temp/qubic-admin.json
```

On success the node returns `{ "peersBroadcasted": 1, "transactionId": "..." }`. Whether the SC accepts the unlock depends on the oracle signatures matching the on-chain order hash computation.

> ⚠️ **Pending: S1** — `UnlockInput` struct layout (variable vs fixed sig slots) must be confirmed with Seeker. Current implementation sends only the actual signature count (variable-length), which keeps the tx under 1024 bytes. Set `FIXED_SIG_SLOTS=64` env var in relay-unlock.js if the SC requires a fixed-size array.

**Relay test result (2026-03-11):**
- Order nonce 1 relayed via 6 oracle signatures → `transactionId: umbgmlbqirvehbmcwkuccqlpaargkuenrugicpxrbdxszwczlhyngzteqnfi`
- Broadcast accepted (`peersBroadcasted: 1`), SC execution result pending Seeker confirmation.

---

### F) Event polling

> ⚠️ **Not available on testnet** — `poll-events.js` and `verify-event.js` use the Bob Node (`/findLog`) which is mainnet-only. The testnet RPC does not expose a log/event query endpoint. Ask Seeker for a testnet event indexer if needed.

---

### G) Typical test flow (end-to-end)

```
1.  [Admin]   Add 6 test oracles:  add-oracle.js  (using .temp/oracle-qubic-keys.json pubkeys)
2.  [Read]    Verify:               get-oracles.js  (blocked: S1 layout)
3.  [User]    Lock funds:           lock.js --from <seed> --to <solana-addr> --amount 1000 --nonce 1
4.  [Read] ✅ Confirm lock:         get-locked-order.js --nonce 1
5.  [Relay] ✅ Unlock on Qubic:    relay-unlock.js  (tx accepted; SC outcome pending Seeker confirm)
6.  [Read]    Check replay guard:   is-order-filled.js --hash <orderHash>  (blocked: S1 layout)
```

Steps 1, 3, 4, and 5 are operational (tx accepted by node). Step 6 requires Seeker to confirm remaining struct layouts.
