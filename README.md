# Paygate

One payment gateway for every product in the portfolio. Products ask it to **collect** money from a customer or **pay out** to one; it talks to the providers (pawaPay mobile money for Côte d'Ivoire, Senegal and Burkina Faso, PI-SPI instant bank payments), keeps the ledger, and tells the product what happened with a signed webhook.

It was extracted from Relay (`~/Downloads/design_handoff_relay_pwa/relay`), where this code first ran inside the app. What moved here: the provider adapters, idempotency, signature checks, reconciliation, float monitoring. What stayed there: pricing, limits, compliance rules, approvals, refunds, and everything about crypto.

```
 product A ─┐                        ┌─ pawaPay  (deposits, payouts, wallets, signed callbacks)
 product B ─┼─ API key ─►  Paygate ──┤
 product C ─┘  ◄─ signed webhooks    └─ PI-SPI   (QR, payment requests, received payments)
```

## Why a shared gateway

- **One callback URL per provider.** pawaPay allows a single callback URL per account; with several products it can only be one place. That place is the gateway, which finds the payment and tells the right product.
- **One float.** The prepaid payout wallet is shared. It is monitored once, for everyone.
- **One implementation of the dangerous parts.** Idempotency, "unknown outcome means stop", signature verification, late completions. Fixed once, fixed everywhere.
- **Credentials in one place.** Products never hold provider secrets.

## What it guarantees

- **A payment is never made twice.** The tenant's `reference` is the idempotency key; the provider's id is derived from it, so retries, restarts and a second instance reach the same id and the provider answers "duplicate".
- **An unknown outcome is never guessed.** If a payout may or may not have been sent, it is `unknown`, an operator is alerted, and it is not retried automatically.
- **The provider is the source of truth for money.** A completion after we reported failure is honoured, flagged `late`, and the product is told.
- **One change, one event.** Every status change is a versioned, conditional update; its event and its webhook are written in the same batch. Concurrent callers cannot both win.
- **Tenants cannot see each other.** Every query is scoped by the tenant of the key; provider ids include the tenant.
- **Fail closed.** The sandbox is refused with `LIVE=true`; pawaPay production is refused without it; an unsigned callback is refused with `LIVE=true`; an unknown provider mode stops everything.

## Using it

See [docs/api.md](docs/api.md) for the API, [docs/operations.md](docs/operations.md) for running it, and [docs/relay-migration.md](docs/relay-migration.md) for moving Relay onto it.

```bash
npm install
cp .dev.vars.example .dev.vars        # set ADMIN_API_KEY and WEBHOOK_MASTER_SECRET
npm run db:migrate:local
npm run dev                           # PROVIDER_MODE=sandbox: nothing moves, the phone number's last digits pick the outcome
npm test                              # 62 tests, node:test, no network
npm run check                         # tsc
```

## Layout

| Path | What |
|---|---|
| `src/index.ts` | The router (`/v1/*` tenants, `/admin/*` operator, `/callbacks/*` providers) and the cron |
| `src/payments.ts` | Creating, starting, re-checking and listing payments; the versioned state change (`applyObserved`) |
| `src/states.ts` | The lifecycle as pure functions |
| `src/providers/` | pawaPay (collect, payout, callbacks), PI-SPI, the sandbox, RFC 9421 signature verification |
| `src/webhooks.ts`, `signing.ts` | Outbound events: outbox, retries, signature |
| `src/callbacks.ts` | Provider callbacks in |
| `src/reconcile.ts`, `float.ts` | Settling what callbacks missed; wallet monitoring |
| `src/tenants.ts`, `admin.ts` | Tenants, API keys, webhook secrets, the operator API |
| `migrations/` | D1 schema |

## Not done yet

- No operator UI (the admin API is JSON only).
- No per-tenant rate limiting; abuse guards are the provider's and the per-tenant `max_amount`.
- No client SDK; [`src/signing.ts`](src/signing.ts) is written to be copied for webhook verification.
- Not tested against the live pawaPay or PI-SPI sandboxes: the adapters are ported from Relay's code, which was, and are tested here against stubs that answer as those providers do. Run `docs/operations.md` → "Before going live" first.
