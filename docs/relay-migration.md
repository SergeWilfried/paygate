# Moving Relay onto Paygate (phase 3, not done)

Relay today calls the providers itself. This is the plan to make it a client of the gateway without a flag day. **Nothing in Relay has been changed yet.**

## The cut

| Relay today | Becomes |
|---|---|
| `worker/deposit/*`, `worker/pispiPayments.ts`, `worker/pispiBuy.ts` (QR) | `POST /v1/collections` (`mobile_money`, `pispi_qr`, `pispi_rtp`) |
| `worker/payout/*` | `POST /v1/disbursements` |
| `worker/float.ts` (balances) | `GET /v1/float`; Relay adds its own payouts waiting for approval |
| `POST /api/webhooks/deposit`, `/payout`, pawaPay signature code | gateway callbacks; Relay receives `payment.*` webhooks |
| `reconcilePayouts`, `refreshBuy` polling | the gateway reconciles; Relay reads status or waits for the webhook |

Stays in Relay: rules and limits, Clef, two-person approval, holds, refunds, buys/sells/swaps, phone proof, crypto, and what "paid" means for an order.

## Steps

1. **A `PaymentGateway` interface in Relay** with the operations above, and two implementations: `local` (the existing code, unchanged) and `gateway` (HTTP/service binding to Paygate). Choose with a var. Both pass the same Relay tests.
2. **Create the Relay tenant** with `idNamespace: "relay"`. Its provider ids are then derived exactly as Relay derives them today (`relay-deposit:<id>`, `relay-payout:<id>`), so a payment started by the old code and finished by the gateway is the same payment at pawaPay. Tested in `test/ids.test.ts` and `test/pawapay.workflow.test.ts`.
3. **Run in the pawaPay sandbox** with `PAYOUT_PROVIDER=gateway`: sell and buy end to end.
4. **Cutover, in this order** (payments in flight are the risk):
   1. Stop new payouts and buys in Relay (the existing hold switches).
   2. Wait for `sending` payouts and `collecting` buys to settle (Relay's own reconcile).
   3. Move the secrets (`PAWAPAY_API_TOKEN`, PI-SPI) to Paygate; point pawaPay's callback URLs at it.
   4. Flip Relay to `gateway`; resume.
   Anything still in flight that was missed is recovered by the gateway because ids match; import it with a `POST /v1/collections` using the same reference (the tenant's `idNamespace` makes it the same provider id, and the provider answers "duplicate").
5. **Delete** the local adapters from Relay once a week has passed clean.

## Differences Relay must handle

- A collection is created **and started** in one call. Relay's buys have two steps (create the order, then start the payment with a one-time code or redirect URLs); the order stays Relay's, and the gateway call is made at "start".
- Statuses map: gateway `completed` → buy `collected` / payout `paid`; `failed` → `failed`; `expired` → `expired`; `unknown` → payout "sending with unknown outcome"; `late: true` → Relay's existing "paid after failure" handling (`settlePaidAfterFailure`, `paid-after-failed`).
- The gateway never calls back synchronously: handle `payment.*` webhooks idempotently on the event `id`.
