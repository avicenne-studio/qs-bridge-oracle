# Devnet .temp Quickstart

This is the shortest path to add oracles and submit an inbound order on devnet using the `.temp` files.

## 1) Generate 6 oracle keypairs (Solana)

```bash
# mkdir -p .temp
# for i in 1 2 3 4 5 6; do
#   OUT=.temp/oracle-${i}.json node scripts/solana/generate-keypair.js > .temp/oracle-${i}.keys.json
#   echo "oracle-${i} generated"
# done
```

## 1b) Generate 6 oracle Qubic keys

Each oracle needs a Qubic identity (55-char seed, publicId) for future Qubic signing. Same layout as Solana: one keys file per oracle.

```bash
# for i in 1 2 3 4 5 6; do
#   OUT=.temp/oracle-${i}.qubic.json node scripts/qubic/generate-keys.js > .temp/oracle-${i}.qubic.keys.json
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
#   npm run solana:add-oracle -- "$PUB"
# done
```

## 4) Create the Address Lookup Table

The inbound relay transaction exceeds the legacy 1232-byte limit. An Address Lookup Table (ALT) compresses account addresses into 1-byte indices. The script reads `SOLANA_RPC_URL` and `TOKEN_MINT` from `.env.local`, detects registered oracles on-chain automatically, and creates + extends the LUT in a single transaction.

```bash
npm run solana:create-lookup-table
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
  orderEra: 0,
  recipient: '46F9i1Bzv8kwShyG8xbtdkA7nEoYmzyueKwjXyDgtAQV',
  protocolName: 'QubicBridge',
  protocolVersion: '1',
};
fs.writeFileSync('.temp/order.json', JSON.stringify(order, null, 2));
NODE
```

## 6) Send an inbound order

```bash
npm run solana:send-inbound-order -- .temp/order.json .temp/oracle-keys.json .temp/oracle-1.json
```

Notes:

- With 6 oracles on-chain, the script signs with 60% (4) by default.
- You can override the signature count: `SIGNATURE_COUNT=4 npm run solana:send-inbound-order -- ...`
- The script will create missing recipient/relayer ATAs automatically.

## 7) Send an outbound order (Solana → Qubic)

Create the outbound order payload. `toAddress` is the Qubic recipient encoded as 32-byte hex.
`relayerFee` must be ≥ `RELAYER_FEE_QUBIC` (500). The nonce is a random 32-byte value.

```bash
node --env-file=.env.local <<'NODE'
import { randomBytes } from 'crypto';
import { writeFileSync } from 'fs';
// qubic-user: QVIYOOAIJABIGFTCMYKWJODOXBJCBJEMGTSKOZGYQFFKPSYZFFJEAOQBTPMH
const QUBIC_USER_HEX = '0xb2e985bf2c2585b457b05bc0e9c8e1501b409ca3651797c255fd914734f95538';
// Amounts are in raw wQubic units (9 decimals). Divide by 1e9 to get QU.
// relayerFee must be >= RELAYER_FEE_QUBIC (500 QU = 500_000_000_000 raw).
const order = {
  networkOut: 1,
  tokenOut: '0x' + '00'.repeat(32),
  toAddress: QUBIC_USER_HEX,
  amount: '2000000000000',      // 2_000 QU (must fit within user's wQubic balance)
  relayerFee: '600000000000',   // 600 QU (>= RELAYER_FEE_QUBIC=500 QU)
  nonce: '0x' + randomBytes(32).toString('hex'),
  orderEra: 0,
};
writeFileSync('.temp/outbound-order.json', JSON.stringify(order, null, 2));
console.log('Written .temp/outbound-order.json');
console.log(order);
NODE
```

Then send — signer is whoever holds the wQubic on Solana (solana-admin = `CHEwXjhGHjeotYANJ4snWqpFLT6YG5Tu5JiFF2vB8EGe`):

```bash
node --env-file=.env.local scripts/solana/send-outbound-order.js \
  .temp/outbound-order.json \
  .temp/solana-admin.json
```

Override an existing outbound order (update relayer fee and/or destination):

```bash
npm run solana:override-outbound-order -- .temp/outbound-order.json .temp/solana-admin.json \
  --relayer-fee 2000 \
  --to-address 0xb2e985bf2c2585b457b05bc0e9c8e1501b409ca3651797c255fd914734f95538
```

## 8) Local Qubic testnet (Core Lite + Bob Node)

The local testnet uses a real Qubic node compiled with `TESTNET=ON` + the Bob Node indexer via Docker.

### Manage the stack (from repo root)

```bash
../qs-bridge-infrastructure/scripts/local-testnet.sh start    # start Core Lite + Bob Node
../qs-bridge-infrastructure/scripts/local-testnet.sh status   # show running state + current tick
../qs-bridge-infrastructure/scripts/local-testnet.sh stop     # stop both (preserves state)
../qs-bridge-infrastructure/scripts/local-testnet.sh reset    # full wipe: Bob volumes + genesis files
../qs-bridge-infrastructure/scripts/local-testnet.sh logs-node  # tail Core Lite log
../qs-bridge-infrastructure/scripts/local-testnet.sh logs-bob   # tail Bob Node Docker log
```

First run or after `reset`, always do `reset && start`.

### Register oracles and pausers (once after reset)

The admin key is `.temp/qubic-admin.keys.json`. This registers the 6 oracle Qubic IDs and all pausers on-chain:

```bash
QUBIC_KEYS=.temp/qubic-admin.json \
  node --env-file=.env.local scripts/qubic/setup-contract.js
```

Verify oracle registration:

```bash
node --env-file=.env.local scripts/qubic/get-oracles.js
```

### Fund qubic-user (testnet pre-fills admin; transfer to user)

The testnet pre-seeds `qubic-admin` with QU on genesis. Transfer some to `qubic-user` if needed:

```bash
# Check balances
QUBIC_KEYS=.temp/qubic-admin.keys.json node --env-file=.env.local scripts/qubic/get-config.js
```

### Lock (Qubic → Solana)

Sender: `qubic-user` (`QVIYOOAIJABIGFTCMYKWJODOXBJCBJEMGTSKOZGYQFFKPSYZFFJEAOQBTPMH`).
`relayerFee` must be ≥ `RELAYER_FEE_SOLANA` (1000) or the oracle won't relay.
Recipient: Solana admin `CHEwXjhGHjeotYANJ4snWqpFLT6YG5Tu5JiFF2vB8EGe` (holds wQubic).

```bash
QUBIC_KEYS=.temp/qubic-user.keys.json \
  node --env-file=.env.local scripts/qubic/send-lock.js \
  --amount 10000 \
  --to-address CHEwXjhGHjeotYANJ4snWqpFLT6YG5Tu5JiFF2vB8EGe \
  --relayer-fee 1005
```

The script prints the order hash on success. Hub picks up the lock event within one poll interval,
oracles sign, and the relay sends wQubic to the recipient on Solana devnet.

### Override lock

```bash
QUBIC_KEYS=.temp/qubic-user.keys.json \
  node --env-file=.env.local scripts/qubic/override-lock.js \
  --nonce <NONCE> \
  --to-address <NEW_SOLANA_ADDR> \
  --relayer-fee 1005
```

### Query a locked order (by nonce)

```bash
node --env-file=.env.local scripts/qubic/get-locked-order.js --nonce <NONCE>
```

## 9) Claim protocol fee (protocol fee recipient only)

```bash
npm run solana:claim-protocol-fee -- .temp/protocol-fee-recipient.json
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
npm run solana:airdrop -- .temp/oracle-1.json
npm run solana:airdrop -- .temp/recipient.json
```

Default amount is 1 SOL (1_000_000_000 lamports). Override by passing lamports:

```bash
npm run solana:airdrop -- .temp/recipient.json 10000000
```

## Notes

- `scripts/solana/send-inbound-order.js` uses the token mint from global state, so `order.json` stays minimal.
- Ensure the relayer key has devnet SOL for fees.
