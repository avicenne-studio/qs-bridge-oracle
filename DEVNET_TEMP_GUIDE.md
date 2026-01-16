# Devnet .temp Quickstart

This is the shortest path to add oracles and submit an inbound order on devnet using the `.temp` files.

## 1) Generate 6 oracle keypairs

```bash
mkdir -p .temp
for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
  OUT=.temp/oracle-${i}.json node scripts/generate-solana-keypair.js > .temp/oracle-${i}.keys.json
  echo "oracle-${i} generated"
done
```

## 2) Bundle oracle keys

```bash
node <<'NODE'
const fs = require('fs');
const files = [1,2,3,4,5,6,7,8,9,10,11,12].map(i => `.temp/oracle-${i}.json`);
const data = files.map(f => JSON.parse(fs.readFileSync(f, 'utf8')));
fs.writeFileSync('.temp/oracle-keys.json', JSON.stringify(data, null, 2));
NODE
```

## 3) Create `.temp/order.json`

```bash
node <<'NODE'
const fs = require('fs');
const { randomBytes } = require('crypto');
const order = {
  networkIn: 1,
  networkOut: 2,
  tokenIn: '0x' + '11'.repeat(32),
  fromAddress: '0x' + '22'.repeat(32),
  toAddress: '4zP2HeDb7qGWNxpXm6JqjQW3Zp2uDU2tc3Nwdbu4BjvW',
  amount: '1000000',
  relayerFee: '1000',
  nonce: '0x' + randomBytes(32).toString('hex'),
  recipient: '4zP2HeDb7qGWNxpXm6JqjQW3Zp2uDU2tc3Nwdbu4BjvW',
  protocolName: 'QubicBridge',
  protocolVersion: '1',
};
fs.writeFileSync('.temp/order.json', JSON.stringify(order, null, 2));
NODE
```

## 4) Add the 12 oracles on-chain

```bash
for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
  PUB=$(node -e "console.log(JSON.parse(require('fs').readFileSync('.temp/oracle-${i}.keys.json','utf8')).pKey)")
  npm run add-oracle -- "$PUB"
done
```

## 5) Send an inbound order

```bash
npm run send-inbound-order -- .temp/order.json .temp/oracle-keys.json .temp/oracle-1.json
```

## 6) Claim protocol fee (protocol fee recipient only)

```bash
npm run claim-protocol-fee -- .temp/protocol-fee-recipient.json
```

Note: this claims **protocol fee**, not oracle claimable balances.

## 6) Re-run with a new nonce

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

## Notes
- `scripts/send-inbound-order.js` uses the token mint from global state, so `order.json` stays minimal.
- Ensure the relayer key has devnet SOL for fees.
