# API

Base URL: your Paygate Worker. All bodies are JSON. Amounts are whole **XOF** (no minor unit). Times are Unix milliseconds.

## Authentication

Every `/v1` call carries `Authorization: Bearer pgk_<id>_<secret>`. The operator creates your key (shown once). A revoked key and a suspended account both answer `401`.

## Errors

```json
{ "error": { "code": "amount_out_of_bounds", "message": "This amount is outside the provider limits", "min": 100, "max": 1000000 } }
```

`code` is stable and meant for programs. Some codes carry extra fields (`min`/`max`, `codeInstructions`).

| Status | Codes |
|---|---|
| 400 | `invalid_request` `invalid_json` `invalid_reference` `invalid_amount` `invalid_currency` `invalid_rail` `invalid_operator` `invalid_phone` `invalid_payer_alias` `invalid_metadata` `invalid_url` `invalid_expiry` `invalid_pre_auth_code` |
| 401 | `unauthorized` |
| 404 | `not_found` |
| 409 | `idempotency_conflict` |
| 413 | `payload_too_large` |
| 422 | `provider_unavailable` `amount_out_of_bounds` `amount_too_large` `pre_auth_code_required` `redirect_urls_required` `no_webhook` |
| 429 | `rtp_limit` |
| 5xx | `internal`, or the request failed before anything was recorded |

## Collections (money in)

`POST /v1/collections`

| Field | |
|---|---|
| `reference` | **Required.** Your own id, 3–64 of `A-Za-z0-9_-`. It makes the call safe to retry: the same reference with the same details returns the same payment (`200`); with different details, `409`. |
| `amount` | **Required.** Whole XOF, at least 100, at most your account limit. |
| `rail` | `mobile_money` (default), `pispi_qr`, `pispi_rtp`. |
| `operator`, `phone` | mobile money: `orange`, `wave`, `moov`; the payer's E.164 number (CIV +225, SEN +221, BFA +226). |
| `payerAlias` | `pispi_rtp`: the customer's PI-SPI alias (a UUID). |
| `preAuthCode` | Providers that need a one-time code first (Orange Burkina Faso). Without it you get `422 pre_auth_code_required` with `codeInstructions` to show the customer. |
| `successUrl`, `failedUrl` | Providers that send the customer to their app (Wave). Required there. https only. |
| `expiresInSeconds` | 60–86400. Defaults: 15 min mobile money, 1 h payment request, 3 h QR. |
| `metadata` | An object, up to 2 KB, returned as given. |

Creating it also starts it, so you get `201` with the payment, `status: "processing"`:

```json
{
  "id": "pg8a5e0f696285f16e8", "object": "collection", "reference": "order-1", "rail": "mobile_money",
  "status": "processing", "amount": 5000, "currency": "XOF", "operator": "orange", "counterparty": "+2250700000001",
  "nextStep": null, "authUrl": null, "qr": null,
  "method": { "authType": "PROVIDER_AUTH", "instructions": { "en": ["Dial *144#"], "fr": ["Composez *144#"] }, "codeInstructions": null },
  "failure": null, "metadata": null, "createdAt": 1791982814330, "expiresAt": 1791983714330, "settledAt": null
}
```

What to show the customer while `processing`: `method.instructions` (approve on the phone), `authUrl` (send them there), or `qr` (render a PI-SPI dynamic QR from its fields).

`GET /v1/collections/{id or reference}` · `GET /v1/collections?reference=…` · `GET /v1/collections?status=&limit=&before=` · `GET /v1/collections/{id}/events`

A read also asks the provider if the payment is still open (at most every 4 seconds), so you can poll. Webhooks are the better way.

## Disbursements (money out)

`POST /v1/disbursements` takes `reference`, `amount`, `operator`, `phone`, `metadata` (mobile money only). It is sent once. Answers `201` with `completed`, `processing` (accepted, settles later), `failed` (nothing was sent), or **`unknown`**.

`unknown` means the request may or may not have reached the provider. **It is not retried.** An operator is alerted and checks the provider. Do not pay the person another way or send it again until the status moves: when it does, you get a webhook. If it ends `failed`, make a new disbursement with a **new** reference.

Reads are the same as for collections, under `/v1/disbursements`.

## Statuses

| Status | Meaning | Final? |
|---|---|---|
| `processing` | Started; waiting for the customer or the provider | no |
| `completed` | The money moved | yes (but see `late`) |
| `failed` | It did not happen; `failure` says why, in words a customer can read | no: it can still complete **late** |
| `expired` | Collections: the window passed unpaid | no: a late payment is honoured |
| `unknown` | Disbursements: outcome unknown, a person decides | no |

**Late completions.** A provider can report a payment after we called it failed or expired (a slow request, a customer who pays after the window). Money is the provider's truth, so it becomes `completed` and you get `payment.completed` with `"late": true` and `"previousStatus": "failed"`. If you already told the customer it failed, or refunded them, you must act on this.

## Webhooks

Set a URL with the operator. Events:

| Type | When |
|---|---|
| `payment.completed` | the money moved (`late` is true if it had been reported failed or expired) |
| `payment.failed` | it did not happen |
| `payment.expired` | a collection's window ended unpaid |
| `payment.unknown` | a disbursement's outcome is unknown: do nothing, wait |
| `payment.mismatch` | PI-SPI: a payment arrived for the wrong amount or by the wrong route; nothing was settled, an operator looks |
| `ping` | `POST /v1/webhooks/test` |

```json
{ "id": "evt_pg8a5e…_1", "type": "payment.completed", "createdAt": 1791982830000, "previousStatus": "processing", "late": false, "data": { …the payment… } }
```

- **At least once.** Dedupe on `id` (also in the `Paygate-Event-Id` header). Order is not guaranteed across payments; `data.status` is always the state at the time of the event, so when in doubt `GET` the payment.
- **Acknowledge with any 2xx.** Anything else is retried after 10 s, 1 min, 5 min, 30 min, 2 h, 6 h, 24 h; then the event is dead and an operator is alerted (they can requeue it).
- **Verify the signature.** Header `Paygate-Signature: t=<unix seconds>,v1=<hex>`, the HMAC-SHA256 of `<t>.<raw body>` with your webhook secret. Check it on the **raw** body, reject if `t` is more than 5 minutes old, compare in constant time. [`src/signing.ts`](../src/signing.ts) does it (copy it).
- Redirects are not followed.

## Other endpoints

- `GET /v1/methods?rail=mobile_money&operator=orange&phone=+225…&direction=collect|disburse&amount=` — whether that way of paying works for that number, with limits and instructions. Ask before you show a customer an option. `?rail=pispi_qr` / `pispi_rtp` say if PI-SPI is on (and whether a person must confirm QR payments).
- `GET /v1/float` — the shared payout wallet per country: balance, the floor, what is committed, last-24 h flows, cover in days. It is the whole gateway's, not yours alone. Payouts you hold back on your side (waiting for your own approval) are not in it: add them.
- `GET /v1/me` — your account, limits, and whether the gateway is live.

## PI-SPI notes

- `pispi_qr`: the gateway returns `qr` (`alias`, `countryCode`, `qrType: "DYNAMIC"`, `referenceLabel`, `amount`). Render it as a PI-SPI dynamic QR; the `referenceLabel` is what ties the bank payment to this payment.
- Settlement is by PI-SPI's own record of received payments, never the customer's word: irrevocable, on our alias, the right category, **exactly** the amount. Otherwise `payment.mismatch`. One bank payment settles one payment only.
- With polling off (`PISPI_POLL`), nothing settles automatically: an operator confirms with `POST /admin/payments/{id}/resolve`.
- `pispi_rtp` sends the customer a payment request. A customer is sent at most 3 per day.

## Operator API (`Authorization: Bearer <ADMIN_API_KEY>`)

| | |
|---|---|
| `POST /admin/tenants` | `{ id, name, webhookUrl?, maxAmount?, idNamespace? }` |
| `PATCH /admin/tenants/{id}` | `{ webhookUrl?, maxAmount?, status?, name? }` (`status`: `active` / `suspended`) |
| `POST /admin/tenants/{id}/keys` | `{ label? }` → `{ id, key }`, shown once |
| `DELETE /admin/tenants/{id}/keys/{keyId}` | revoke |
| `GET /admin/tenants/{id}/webhook-secret` | the secret your product verifies with; `POST` rotates it |
| `GET /admin/payments?status=&tenant=&kind=` | with the detail tenants never see |
| `GET /admin/payments/{id}` | with its full history |
| `POST /admin/payments/{id}/resolve` | `{ outcome: "completed" \| "failed", note }` for an `unknown` payout or a manually confirmed PI-SPI payment |
| `GET /admin/webhooks/dead`, `POST /admin/webhooks/{id}/retry` | undeliverable events |
| `GET /admin/float`, `GET /admin/provider-events` | wallets; the last 100 provider callbacks as received |

## Provider callbacks (not for products)

`POST /callbacks/pawapay/deposits` and `/callbacks/pawapay/payouts`: set these in the pawaPay dashboard, with **signed callbacks on**.
