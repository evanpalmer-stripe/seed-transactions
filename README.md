# Seed Transactions Console Application

A simple Node.js console application for creating test transactions in Stripe.

## Getting Started

### Prerequisites

- Node.js (v14 or higher)
- Stripe test API keys (get them from https://dashboard.stripe.com/test/apikeys)

### Installation

Install dependencies:

```bash
npm install
```

### Usage

Run the application:

```bash
npm start
```

Or directly:

```bash
node index.js
```

On first run, you'll be prompted to enter your Stripe API keys:
- Publishable Key (pk_test_...)
- Secret Key (sk_test_...)

These keys will be saved locally in `config.json` and remembered for future runs.

## Features

- ✅ Securely store and remember API keys between sessions
- ✅ Create test payment intents
- ✅ List recent charges
- ✅ Reset stored API keys
- ✅ Interactive menu-driven interface

## Security

⚠️ **Important**: 
- Only use **test** API keys (pk_test_... and sk_test_...)
- The `config.json` file is git-ignored to prevent accidental commits
- Never commit your API keys to version control

## License

ISC

