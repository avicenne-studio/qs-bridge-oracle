# Devnet .temp Quickstart

This is the shortest path to add oracles and submit an inbound order on devnet using the `.temp` files.

## 1) Generate 6 oracle keypairs

```bash
# mkdir -p .temp
# for i in 1 2 3 4 5 6; do
#   OUT=.temp/oracle-${i}.json node scripts/generate-solana-keypair.js > .temp/oracle-${i}.keys.json
#   echo "oracle-${i} generated"
# done
```

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


## 4) Create/Override `.temp/order.json`

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


## 5) Send an inbound order

```bash
npm run send-inbound-order -- .temp/order.json .temp/oracle-keys.json .temp/oracle-1.json
```

Notes:
- With 6 oracles on-chain, the script signs with 60% (4) by default.
- You can override the signature count: `SIGNATURE_COUNT=4 npm run send-inbound-order -- ...`
- The script will create missing recipient/relayer ATAs automatically.

## 6) Send an outbound order (unlock/burn)

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

## 7) Claim protocol fee (protocol fee recipient only)

```bash
npm run claim-protocol-fee -- .temp/protocol-fee-recipient.json
```

Note: this claims **protocol fee**, not oracle claimable balances.

## 8) Re-run with a new nonce

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
