# claude.md — Polymarket Last-Minute Anomaly Bot (Large Bets + Asymmetric Books + New Accounts)

## 0) Objective
Build a production-grade research bot (paper mode default) that detects **last-minute anomalies** on Polymarket with explicit emphasis on:
- **Large bet / trade size tail events**
- **Asymmetric order books** (depth imbalance + thin opposite side)
- **New/low-history accounts** (public on-chain "first seen" proxies)

The bot outputs ranked opportunities + recommended sizing under strict risk controls. Live trading is optional and hard-gated.

---

## 1) Requirements (MECE)

### 1.1 Data Acquisition
**Sources**
1) Polymarket market metadata (id, outcomes, category, close time, status)
2) Order book snapshots (bids/asks depth tiers, best bid/ask, spread)
3) Trade tape (timestamp, size/notional, price, side, wallet if available)
4) On-chain wallet activity (first seen timestamp, trade count proxy)

**Cadence**
- Book snapshots: 1–5s (config)
- Trades: streaming if possible, else 1s poll (config)
- Wallet enrichment: on first encounter + cached (TTL)

**Staleness rules**
- If any stream is stale beyond threshold (e.g., 10s), system enters NO-TRADE and flags data-quality errors.

### 1.2 Storage
- Postgres for metadata, decisions, audits, configs
- Timescale (or Postgres hypertables) for book/trade time-series
- Redis for rolling windows + state

### 1.3 Canonical Schemas
**Market**
- market_id, question, category, outcomes[], close_time, status

**OrderBookSnapshot**
- market_id, ts
- bids[{px, qty}], asks[{px, qty}]
- best_bid, best_ask, mid, spread
- depth_bid_topN, depth_ask_topN

**Trade**
- market_id, ts
- wallet, side, px, qty, notional

**WalletProfile (public proxy)**
- wallet
- first_seen_ts
- markets_traded_lookback
- trades_count_lookback
- notional_lookback

**FeatureVector (per market/outcome/time)**
- t_close_sec, t_close_norm
- size_tail_score
- book_imbalance_score
- thin_opposite_score
- spread_score, depth_score
- impact_score_30s, impact_score_60s
- trade_rate, burst_intensity
- wallet_new_score, wallet_activity_score, wallet_concentration_score
- change_point_score
- anomaly_score, execution_score, edge_score
- decision fields (action, target_size, limit_px)

---

## 2) Feature Engineering (MECE)

### 2.1 Time-to-Close Features
- `t_close_sec = close_time - now`
- `time_ramp = ramp(t_close_sec)`:
  - 0 when `t_close_sec > T1` (e.g., 2h)
  - linear up to 1 by `t_close_sec <= T2` (e.g., 10m)
  - hard-disable inside `NO_TRADE_ZONE` (e.g., last 120s) except mechanical arb

### 2.2 Large Bet / Size Tail Features
Compute per market rolling baselines (lookback L, e.g., 6–24h):
- Robust z-score: `(notional - median) / MAD`
- Tail quantiles: q95/q99/q999 (approx with t-digest)
- `size_tail_score ∈ [0,1]`:
  - 0.5 at q95
  - 0.9 at q99
  - 0.98 at q999

### 2.3 Asymmetric Order Book Features
Using top-N depth (e.g., N=5 or $ notional depth):
- Depth imbalance: `(bidDepth - askDepth)/(bidDepth + askDepth)`
- `book_imbalance_score`:
  - map abs(imbalance) to [0,1] with saturation
- Thin opposite side:
  - if trade is BUY, opposite side is ASK depth
  - compute `thin_opposite_ratio = oppDepth / sameDepth`
  - `thin_opposite_score = 1 - clamp(thin_opposite_ratio)`
- Spread regime:
  - `spread_score`: penalize wide spreads (execution risk)
- Depth adequacy:
  - `depth_score`: reward sufficient top-of-book depth

### 2.4 New Account / Low History Features (public proxies)
For each wallet:
- `wallet_age_days = (now - first_seen_ts)/86400`
- `wallet_new_score`:
  - 1.0 if age < 7d
  - 0.7 if age < 30d
  - 0.3 if age < 180d
  - 0.0 otherwise
- `wallet_activity_score`:
  - low trades count + low markets traded increases suspicion weight
- Concentration:
  - `wallet_concentration_score`: volume share of top N wallets in last X minutes

### 2.5 Impact / Confirmation Features
- After large trade, compute mid drift in trade direction:
  - `impact_30s = sign * (mid(t+30s) - mid(t))/mid(t)`
  - `impact_60s` similarly
- `impact_score`: scaled positive-only confirmation; negative impact reduces confidence.

### 2.6 Burst / Clustering Features
- Trade rate: trades per minute
- Burst intensity:
  - simple Hawkes proxy or inter-arrival compression:
    - `burst = exp(-mean_interarrival / baseline_mean)`
- Optional upgrade: real Hawkes exponential kernel intensity.

### 2.7 Change-Point Detection (Online)
Implement at least one fast online CPD:
- FOCuS / functional pruning CUSUM on selected streams:
  - [trade_rate, spread, imbalance, impact proxy, size median]
- Output `change_point_score ∈ [0,1]`

---

## 3) Scoring & Trigger Logic (MECE)

### 3.1 Composite Insider-Proxy Trigger (explicit triple condition)
A high-confidence "triple-signal" event requires:
- `size_tail_score >= 0.90` AND
- `book_imbalance_score >= 0.70` AND `thin_opposite_score >= 0.70` AND
- `wallet_new_score >= 0.80` (new) OR (`wallet_activity_score` very low)

Optional confirmation:
- `impact_score > 0` OR `change_point_score >= 0.7`

### 3.2 AnomalyScore
Compute:
- `core = 0.35*size_tail_score + 0.30*(0.6*book_imbalance_score+0.4*thin_opposite_score) + 0.20*wallet_new_score + 0.15*impact_score`
- `context = max(change_point_score, burst_intensity)`
- `anomaly_score = clamp( time_ramp * (0.7*core + 0.3*context) )`

### 3.3 ExecutionScore
Measures fillability + slippage risk:
- liquidity: top-of-book depth, depth at limit px
- spread: narrower better
- volatility/impact: penalize unstable markets
- time: penalize near close; hard gate in no-trade zone

`execution_score = 0.40*depth_score + 0.25*(1-spread_penalty) + 0.25*(1-vol_penalty) + 0.10*time_ramp`

### 3.4 EdgeScore
Paper-mode edge proxy:
- If you have a calibrated drift model, use `p_model - p_market`.
- If not, use `edge_proxy = anomaly_score * execution_score` and treat as ranking only.

`edge_score = anomaly_score * execution_score`

---

## 4) Decisioning & Bet Sizing (MECE)

### 4.1 Modes
- **Paper (default):** produce decisions + simulated fills
- **Live (disabled by default):** executor runs only if `ENABLE_LIVE_TRADING=true`

### 4.2 Order Selection
Only consider if:
- `anomaly_score >= A_min` (e.g., 0.65)
- `execution_score >= E_min` (e.g., 0.55)
- Not in NO-TRADE-ZONE unless mechanical arb

### 4.3 Sizing
Fractional Kelly with conservative caps:
- Estimate edge `e`:
  - if calibrated: `e = p_model - p_market`
  - else: `e = k * edge_score` (k small, only for paper)
- `f_raw = kelly_scale * e / variance_proxy`
- `f = clamp(f_raw, 0, max_fraction_per_trade)`
Defaults:
- `kelly_scale=0.25`
- `max_fraction_per_trade=0.01` (1% bankroll)

---

## 5) Risk Guardrails (non-negotiable)

### 5.1 Bankroll Limits
- Max per trade: 1% bankroll
- Max per market: 3% bankroll
- Max correlated cluster: 5% bankroll (cluster by category + correlation graph)
- Daily loss limit: 2% (halt)
- Weekly loss limit: 5% (halt)

### 5.2 Execution Limits
- Max spread threshold
- Min depth threshold
- Max slippage threshold
- No trading on stale data
- No trading in last 120s to close (configurable), except deterministic arb

### 5.3 Circuit Breakers
- API errors > threshold: pause
- Missing book/trade updates: pause
- Clock drift: pause
- Unexpected balances/positions: pause + alert

---

## 6) Security & Secret Handling (MECE)

### 6.1 Key Management
- No secrets in repo.
- `.env` only for local dev; `.env` in `.gitignore`.
- Production uses secret manager (AWS/GCP/Vault) or Docker/K8s secrets.
- Separate hot wallet per environment; keep minimal funds.

### 6.2 Git Best Practices
- Commit `.env.example` only.
- Pre-commit hooks:
  - gitleaks + detect-secrets
  - block patterns: PRIVATE_KEY, MNEMONIC, SEED, etc.
- CI secret scan on PRs; fail builds on findings.

### 6.3 Process Separation
- Decision service has **no keys**
- Execution service has keys and re-checks risk before placing order
- Audit log is append-only

### 6.4 Logging
- Structured logs with redaction
- Never print env vars or raw request headers
- Persist order intent, hash, and non-sensitive metadata only

---

## 7) Architecture (MECE)

### 7.1 Services
1) collector: pulls market/book/trades
2) normalizer: canonical schemas + validation
3) wallet_enricher: public first-seen + activity proxies
4) feature_engine: rolling features + CPD + burst
5) scorer: anomaly/execution/edge scoring
6) strategy: decides actions + sizing
7) paper_engine: sim fill + pnl
8) executor (optional): live orders, idempotent
9) risk: approvals, exposure ledger
10) audit: append-only record
11) dashboard: JSON API + alerts

### 7.2 Tech Stack
- TypeScript, Node 20+
- Postgres + Timescale
- Redis
- zod (schemas), pino (logging), bullmq (jobs)

---

## 8) Repo Layout

```
polymarketbot_v1/
├── packages/
│   ├── shared/                    # Shared types, schemas, utilities
│   │   ├── src/
│   │   │   ├── schemas/          # Zod schemas
│   │   │   │   ├── market.schema.ts
│   │   │   │   ├── orderbook.schema.ts
│   │   │   │   ├── trade.schema.ts
│   │   │   │   ├── wallet.schema.ts
│   │   │   │   ├── feature.schema.ts
│   │   │   │   ├── score.schema.ts
│   │   │   │   ├── decision.schema.ts
│   │   │   │   └── index.ts
│   │   │   ├── types/            # TypeScript interfaces
│   │   │   ├── constants/        # System constants
│   │   │   ├── utils/            # Shared utilities
│   │   │   │   ├── time.ts
│   │   │   │   ├── math.ts
│   │   │   │   ├── redis-keys.ts
│   │   │   │   └── staleness.ts
│   │   │   └── index.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── collector/                 # Service 1: Data collector
│   │   ├── src/
│   │   │   ├── clients/
│   │   │   │   ├── clob-rest.client.ts
│   │   │   │   ├── clob-ws.client.ts
│   │   │   │   └── gamma.client.ts
│   │   │   ├── handlers/
│   │   │   │   ├── market.handler.ts
│   │   │   │   ├── orderbook.handler.ts
│   │   │   │   └── trade.handler.ts
│   │   │   ├── jobs/
│   │   │   │   ├── market-metadata.job.ts
│   │   │   │   ├── orderbook-snapshot.job.ts
│   │   │   │   └── trade-poll.job.ts
│   │   │   └── index.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── normalizer/                # Service 2: Schema normalization
│   ├── wallet-enricher/           # Service 3: Wallet enrichment
│   ├── feature-engine/            # Service 4: Feature computation
│   ├── scorer/                    # Service 5: Scoring engine
│   ├── strategy/                  # Service 6: Decision making
│   ├── paper-engine/              # Service 7: Paper trading
│   ├── executor/                  # Service 8: Live execution (optional)
│   ├── risk/                      # Service 9: Risk management
│   ├── audit/                     # Service 10: Audit logging
│   └── dashboard/                 # Service 11: API + alerts
├── migrations/                    # Database migrations
│   ├── 001_initial_schema.sql
│   ├── 002_hypertables.sql
│   ├── 003_indexes.sql
│   └── 004_audit_tables.sql
├── docker/                        # Service Dockerfiles
├── scripts/
│   ├── setup-db.sh
│   ├── seed-markets.ts
│   └── backfill-historical.ts
├── .env.example
├── .gitignore
├── .pre-commit-config.yaml
├── docker-compose.yml
├── docker-compose.prod.yml
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.base.json
└── README.md
```

---

## 9) API Reference

### 9.1 Polymarket CLOB API
- Base URL: `https://clob.polymarket.com`
- WebSocket: `wss://ws-subscriptions-clob.polymarket.com/ws/market`
- Key endpoints:
  - `GET /book?token_id={id}` - Order book snapshot
  - `GET /midpoint?token_id={id}` - Current midpoint price
  - `GET /price?token_id={id}&side={BUY|SELL}` - Best price for side
  - `GET /trades?token_id={id}&limit={n}` - Recent trades
  - `POST /order` - Place order (L2 auth required)

### 9.2 Gamma API
- Base URL: `https://gamma-api.polymarket.com`
- Key endpoints:
  - `GET /markets` - List markets with filters
  - `GET /markets/{condition_id}` - Single market details

### 9.3 Polygonscan API
- Base URL: `https://api.polygonscan.com/api`
- Used for wallet first-seen timestamps and transaction counts

---

## 10) Configuration Defaults

```typescript
// Collection
ORDERBOOK_SNAPSHOT_INTERVAL_MS=1000
TRADE_POLL_INTERVAL_MS=1000
STALENESS_THRESHOLD_MS=10000

// Feature Engineering
ROLLING_WINDOW_MINUTES=60
TDIGEST_COMPRESSION=100
HAWKES_ALPHA=0.5
HAWKES_BETA=0.1
FOCUS_THRESHOLD=5.0

// Scoring
MIN_ANOMALY_SCORE=0.65
MIN_EXECUTION_SCORE=0.55
TIME_RAMP_ALPHA=2.0
TIME_RAMP_BETA=0.1

// Risk
MAX_EXPOSURE_PCT=0.10
MAX_SINGLE_BET_PCT=0.02
MAX_POSITION_PCT=0.05
DAILY_LOSS_LIMIT_PCT=0.05
MAX_DRAWDOWN_PCT=0.15
NO_TRADE_ZONE_SECONDS=120

// Strategy
KELLY_FRACTION=0.25
MIN_BET_SIZE_USD=5

// Execution
PAPER_MODE=true
ENABLE_LIVE_TRADING=false
PAPER_INITIAL_BANKROLL=10000
```

---

## 11) Development Commands

```bash
# Install dependencies
pnpm install

# Run all services in dev mode
pnpm dev

# Run specific service
pnpm --filter @polymarketbot/collector dev

# Type check
pnpm typecheck

# Lint
pnpm lint

# Test
pnpm test

# Build all packages
pnpm build

# Database migrations
pnpm migrate

# Docker dev environment
docker compose up -d

# Docker production
docker compose -f docker-compose.prod.yml up -d
```
