# Qubic Solana Bridge Oracle

This is the repository hosts the oracle validating Solana - Qubic bridge transactions.

Built with Fastify and TypeScript, the service favors predictable behavior, complete test coverage, and transparent operations so integrators can audit and extend it easily.

## Prerequisites
- Node.js 24+

## Getting Started
Install project dependencies:
```bash
npm install
```

### Environment
Copy `.env.example` to `.env`.

## Development Workflow

Build the TypeScript sources:
```bash
npm run build
```

Start Fastify with hot reload:
```bash
npm run dev
```
Visit http://localhost:3000 to confirm the API is reachable.

Run the production server:
```bash
npm run start
```

Run the standalone binary (see `src/server.ts`):
```bash
npm run standalone
```

## Testing and Coverage
Execute the full test suite:
```bash
npm run test
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

## Contributing
Bug reports and pull requests are welcome.
Please describe the use case, add tests that keep coverage at 100%.
