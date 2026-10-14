# Operations

## Set up

```bash
npx wrangler d1 create paygate          # put the id in wrangler.jsonc
npx wrangler kv namespace create CACHE  # put the id in wrangler.jsonc
npm run db:migrate
npx wrangler secret put ADMIN_API_KEY            # 24+ random characters
npx wrangler secret put WEBHOOK_MASTER_SECRET    # 24+ random characters. Webhook secrets are derived from it: do not lose or change it
npx wrangler secret put PAWAPAY_API_TOKEN
npx wrangler secret put ALERT_WEBHOOK_URL        # Slack or Discord incoming webhook
npm run deploy
```

PI-SPI (optional): secrets `PI_SPI_ACCOUNT_ALIAS`, `PI_SP_API_CLIENT_ID`, `PI_SP_API_CLIENT_SECRET`, `PI_SPI_API_KEY`; vars `PI_SPI_PARTICIPANT`, `PI_SPI_BUSINESS_API_URL`, `PI_SP_API_OAUTH_URL`, then `PISPI_ENABLED`, `PISPI_POLL`, `PISPI_RTP`. Reading and sending are separate switches.

## Add a product

```bash
A='Authorization: Bearer <ADMIN_API_KEY>'
curl -X POST $GW/admin/tenants -H "$A" -H 'content-type: application/json' -d '{"id":"courtly","name":"Courtly","webhookUrl":"https://courtly.example/paygate"}'
curl -X POST $GW/admin/tenants/courtly/keys -H "$A" -d '{"label":"prod"}'      # give the key to the product (shown once)
curl $GW/admin/tenants/courtly/webhook-secret -H "$A"                          # and the secret it verifies webhooks with
```

Set `maxAmount` per product if it should be lower than `DEFAULT_MAX_AMOUNT`.

## Modes

| `PROVIDER_MODE` | `LIVE` | |
|---|---|---|
| `sandbox` | `false` | Nothing moves; the last digits of the phone number pick the outcome (`…0000` refused, `…0002` fails, `…9999` stays pending, `…5555` network error, otherwise completes). For development. |
| `pawapay` | `false` | pawaPay's **sandbox** (`api.sandbox.pawapay.io`): no money moves. |
| `pawapay` | `true` | Real money. Refused with the sandbox URL; unsigned callbacks refused. |

Unsafe combinations stop the Worker (it answers 500 to everything) rather than run.

## Before going live

1. In the pawaPay dashboard set the **deposit and payout callback URLs** to `/callbacks/pawapay/deposits` and `/callbacks/pawapay/payouts`, with **signed callbacks on**. With `LIVE=true` an unsigned callback settles nothing (the cron still does, every minute).
2. Run a collection and a payout through the **pawaPay sandbox** (`PROVIDER_MODE=pawapay`, `LIVE=false`) and check `GET /admin/provider-events` to see what a real callback looks like.
3. Set a **minimum wallet balance** per wallet in pawaPay's settlement settings, so a settlement cannot empty the float. Top-ups are a bank transfer and take days.
4. Watch the alert channel for the first week. Alerts to expect to act on: *outcome unknown*, *callback for a payment we don't know*, *webhook undeliverable*, *wallet low/critical*, *payment completed after being reported failed*, *PI-SPI payment does not match*.

## What the cron does (every minute)

1. Delivers due webhooks.
2. Asks the provider about open payments not looked at for a minute; sends a disbursement that was recorded but never sent; looks again, hourly, at failed or expired payments of the last day (a week for PI-SPI) in case they completed late.
3. Every fifth minute: checks the wallets (alerts at most once per 12 hours per country and level).

## Runbook

| Alert | Do |
|---|---|
| **Disbursement outcome unknown** | Look the payment up at pawaPay (`GET /admin/payments/{id}` shows its provider id). Then `POST /admin/payments/{id}/resolve` with `completed` or `failed` and a note. Never send it again. |
| **Completed after being reported failed** | The customer was charged (collection) or the recipient paid (disbursement) after the product was told otherwise. Tell the product's owner; they may have refunded or re-paid. |
| **Callback for a payment the gateway does not know** | Read `GET /admin/provider-events`. Usually a different environment pointing at the same pawaPay account, or a payment started elsewhere. |
| **Webhook undeliverable** | Fix the product's endpoint, then `POST /admin/webhooks/{id}/retry`. |
| **PI-SPI payment does not match** | The customer paid the wrong amount or by another route. Nothing was settled. Refund or complete by hand, then `resolve`. |
| **Wallet low / critical** | Top up that country's wallet at pawaPay. |

## Known limits

- One operator key; no UI.
- A tenant's webhook is delivered from the cron and after each request, so a quiet gateway delivers within a minute at worst.
- Reading a payment at most every 4 seconds per payment reaches the provider; there is no per-tenant rate limit yet.
