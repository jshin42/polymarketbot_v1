# Polymarket Last-Minute Anomaly Bot

A production-grade research bot for detecting last-minute anomalies on Polymarket prediction markets, with emphasis on large bets, asymmetric order books, and new/low-history account activity.

## 🎯 Overview

This bot detects potential insider trading signals by analyzing:
- **Large bet / trade size tail events** (robust z-scores, t-digest quantiles)
- **Asymmetric order books** (depth imbalance + thin opposite side)
- **New/low-history accounts** (on-chain wallet activity proxies)

The system runs in **paper mode by default** for research and backtesting, with optional live trading hard-gated behind explicit configuration.

## 📋 Features

### Data Collection
- Real-time WebSocket streams from Polymarket CLOB API
- Market metadata from Gamma API
- On-chain wallet enrichment via Polygonscan
- Staleness detection with automatic NO-TRADE triggers

### Feature Engineering
- **T-Digest**: Streaming quantile estimation for trade size distribution
- **Robust Z-Score**: MAD-based outlier detection resilient to extreme values
- **FOCuS/CUSUM**: Online change-point detection for regime shifts
- **Hawkes Process**: Self-exciting point process for burst detection
- Time-to-close ramp functions with exponential weighting

### Scoring System
- **Anomaly Score**: Weighted combination of size, book, wallet, and context signals
- **Execution Score**: Fillability, spread penalty, liquidity assessment
- **Edge Score**: Implied vs. estimated probability with confidence intervals
- **Composite Score**: Multi-dimensional ranking with time ramp applied

### Risk Management
- Fractional Kelly sizing with conservative caps (0.25 Kelly, 2% max bet)
- Bankroll limits: 10% total exposure, 2% per trade, 5% per position
- Circuit breakers: 5% daily loss, 15% max drawdown, consecutive loss limits
- No-trade zone in last 120s before market close

### Architecture
- TypeScript monorepo with pnpm workspaces
- PostgreSQL + TimescaleDB for time-series data
- Redis for rolling windows and algorithm state
- BullMQ for job processing
- Zod for runtime schema validation

## 🚀 Quick Start

### Prerequisites
- Node.js 20+
- pnpm 9+
- Docker & Docker Compose
- Polygonscan API key (free tier)

### 1. Clone and Install

```bash
cd polymarketbot_v1
pnpm install
```

### 2. Configure Environment

```bash
cp .env.example .env
# Edit .env with your configuration
```

**Required variables:**
```env
# Polygonscan API key for wallet enrichment
POLYGONSCAN_API_KEY=your_key_here

# Paper trading (default)
PAPER_MODE=true
PAPER_INITIAL_BANKROLL=10000
```

### 3. Start Infrastructure

```bash
# Start PostgreSQL + Redis
pnpm docker:up

# Run database migrations
pnpm migrate
```

### 4. Development

```bash
# Build all packages
pnpm build

# Run all services in dev mode
pnpm dev

# Or run specific services
pnpm dev:collector
pnpm dev:feature-engine
pnpm dev:scorer
```

## 📦 Package Structure

```
packages/
├── shared/           # Types, schemas, utilities (foundation)
├── collector/        # Market/book/trade data collection
├── normalizer/       # Schema validation + transformation
├── wallet-enricher/  # On-chain wallet activity proxies
├── feature-engine/   # Rolling features, CPD, burst detection
├── scorer/           # Anomaly/execution/edge scoring
├── strategy/         # Decision logic + Kelly sizing
├── paper-engine/     # Simulated fills + PnL tracking
├── executor/         # Live orders (optional, hard-gated)
├── risk/             # Guardrails + circuit breakers
├── audit/            # Append-only logging
└── dashboard/        # JSON API + alerts
```

## 🔐 Security

### Secret Management
- **Never commit secrets** - `.env` is in `.gitignore`
- Use `.env.example` for documentation only
- Production: use secret manager (AWS/GCP/Vault)
- Separate hot wallets per environment with minimal funds

### Pre-commit Hooks
```bash
# Install pre-commit hooks
pip install pre-commit
pre-commit install

# Hooks include:
# - gitleaks (secret detection)
# - detect-secrets
# - TypeScript type checking
# - ESLint
```

### Process Separation
- **Decision service**: No keys, generates trading signals
- **Execution service**: Has keys, re-validates risk before orders
- **Audit log**: Append-only, never logs sensitive data

## 📊 Database Schema

### Time-Series Tables (Hypertables)
- `orderbook_snapshots`: Order book states every 1-5s
- `trades`: All trades with wallet addresses
- `features`: Computed feature vectors
- `scores`: Anomaly/execution/edge scores
- `audit_log`: Append-only event log

### Reference Tables
- `markets`: Market metadata from Gamma API
- `tokens`: Outcome tokens per market
- `wallets`: Enriched wallet profiles
- `decisions`: Trading decisions
- `paper_positions`: Paper trading positions

## 🎛️ Configuration

Key configuration in `config` table (editable at runtime):

| Key | Default | Description |
|-----|---------|-------------|
| `strategy.min_anomaly_score` | 0.65 | Minimum anomaly score to trade |
| `strategy.min_execution_score` | 0.55 | Minimum execution score |
| `strategy.kelly_fraction` | 0.25 | Fractional Kelly multiplier |
| `risk.max_exposure_pct` | 0.10 | Max total exposure (10% bankroll) |
| `risk.daily_loss_limit_pct` | 0.05 | Daily loss circuit breaker (5%) |
| `risk.no_trade_zone_seconds` | 120 | No-trade before close (2 min) |

## 🧪 Testing

```bash
# Run all tests
pnpm test

# Run tests for specific package
pnpm --filter @polymarketbot/feature-engine test

# Run integration tests
pnpm test:integration

# Run E2E tests
pnpm test:e2e
```

## 📈 Monitoring

### Logs
Structured JSON logs via Pino:
```bash
# View logs
pnpm docker:logs

# Filter by service
docker logs polymarket-collector -f
```

### Alerts
Configure webhooks in `.env`:
- Discord: `DISCORD_WEBHOOK_URL`
- Telegram: `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`
- Generic: `ALERT_WEBHOOK_URL`

## 🛠️ Development

### Code Quality
```bash
# Lint
pnpm lint

# Format
pnpm format

# Type check
pnpm typecheck
```

### Adding a New Service
1. Create package directory: `packages/new-service/`
2. Add `package.json` with workspace dependency
3. Add to `pnpm-workspace.yaml` (auto-detected)
4. Reference from other packages: `@polymarketbot/new-service`

## ⚠️ Live Trading (Advanced)

**WARNING**: Live trading involves real money. Only enable after extensive paper trading validation.

### Prerequisites
1. Run in paper mode for at least 1 week
2. Validate all signals manually
3. Obtain Polymarket CLOB API credentials
4. Test with minimal bankroll first

### Enable Live Trading
```env
# In .env
PAPER_MODE=false
ENABLE_LIVE_TRADING=true

# L2 Authentication
POLYMARKET_API_KEY=your_api_key
POLYMARKET_SECRET=your_secret
POLYMARKET_PASSPHRASE=your_passphrase
POLYMARKET_ADDRESS=your_address
POLYMARKET_PRIVATE_KEY=your_private_key
```

**Risk Controls** (always active):
- Max 2% of bankroll per trade
- Max 10% total exposure
- 5% daily loss → automatic halt
- 15% drawdown → automatic halt

## 📚 Documentation

- [claude.md](./claude.md) - Full technical specification
- [Polymarket CLOB API](https://docs.polymarket.com/developers/CLOB/introduction)
- [Polymarket Gamma API](https://docs.polymarket.com/developers/gamma-markets-api/overview)

## 🤝 Contributing

This is a private research bot. For questions or issues:
1. Check existing documentation
2. Review `claude.md` for implementation details
3. Test in paper mode first

## 📝 License

Private - All Rights Reserved

## ⚖️ Legal Disclaimer

This software is for educational and research purposes only. Users are solely responsible for:
- Compliance with all applicable laws and regulations
- Financial risks and losses
- Proper use of API credentials and private keys
- Adherence to Polymarket's terms of service

The authors assume no liability for financial losses, legal issues, or misuse of this software.

---

**Built with TypeScript, PostgreSQL, Redis, and production-grade algorithms for statistical anomaly detection.**
