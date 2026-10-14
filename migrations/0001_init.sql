-- Paygate: one gateway, many products ("tenants"). Every payment row belongs to exactly one tenant, and every query on the tenant API filters by it.

CREATE TABLE IF NOT EXISTS tenants (
  id               TEXT PRIMARY KEY,            -- short slug chosen by the operator, e.g. relay
  name             TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'active',   -- active | suspended
  webhook_url      TEXT,                        -- where payment events are POSTed (https only)
  webhook_version  INTEGER NOT NULL DEFAULT 1,  -- the signing secret is derived from the master secret + id + this; bump it to rotate
  max_amount       INTEGER,                     -- largest single payment in XOF, null = the gateway default
  id_namespace     TEXT,                        -- keeps a migrated product's provider ids unchanged (see src/ids.ts); null for new tenants
  created_at       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  id           TEXT PRIMARY KEY,                -- the public part of the key (pgk_<id>_<secret>)
  tenant_id    TEXT NOT NULL REFERENCES tenants (id),
  hash         TEXT NOT NULL,                   -- SHA-256 of the whole key; the key itself is shown once and never stored
  label        TEXT,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at   INTEGER
);
CREATE INDEX IF NOT EXISTS api_keys_tenant ON api_keys (tenant_id);

-- A collection (money in, from a customer) or a disbursement (money out, to a customer).
-- processing -> completed | failed | expired ;  disbursements can also sit in 'unknown' (the provider may have paid: a person decides)
CREATE TABLE IF NOT EXISTS payments (
  id              TEXT PRIMARY KEY,             -- pg + 18 hex; also the PI-SPI txId (upper case) and pawaPay's clientReferenceId
  tenant_id       TEXT NOT NULL REFERENCES tenants (id),
  kind            TEXT NOT NULL,                -- collection | disbursement
  reference       TEXT NOT NULL,                -- the tenant's own id for it: the idempotency key
  rail            TEXT NOT NULL,                -- mobile_money | pispi_qr | pispi_rtp
  operator        TEXT,                         -- orange | wave | moov (mobile_money)
  country         TEXT,                         -- CIV | SEN | BFA (mobile_money)
  counterparty    TEXT NOT NULL,                -- E.164 phone, or the PI-SPI payer alias for pispi_rtp, or '' for pispi_qr
  amount          INTEGER NOT NULL,             -- XOF has no minor unit
  currency        TEXT NOT NULL DEFAULT 'XOF',
  status          TEXT NOT NULL,
  version         INTEGER NOT NULL DEFAULT 0,   -- +1 on every status change: the optimistic lock, and what makes each event id unique
  provider        TEXT NOT NULL,                -- pawapay | pispi | sandbox
  provider_id     TEXT,                         -- the provider's id for it (a UUIDv4 for pawaPay)
  provider_ref    TEXT,                         -- the provider's settlement id (PI-SPI end2endId)
  auth_type       TEXT,                         -- PROVIDER_AUTH | REDIRECT_AUTH | PREAUTH
  method          TEXT,                         -- JSON: how the customer approves (instructions), read from the provider when the payment was made
  next_step       TEXT,
  auth_url        TEXT,
  failure         TEXT,                         -- customer-safe
  failure_detail  TEXT,                         -- logs and support only, never returned to a tenant
  request_hash    TEXT NOT NULL,                -- SHA-256 of the request: the same reference with different details is a conflict, not a retry
  metadata        TEXT,                         -- JSON, returned as given
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_checked_at INTEGER,
  expires_at      INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  settled_at      INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS payments_reference ON payments (tenant_id, kind, reference);
CREATE UNIQUE INDEX IF NOT EXISTS payments_provider_id ON payments (provider_id) WHERE provider_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS payments_open ON payments (status, updated_at);
CREATE INDEX IF NOT EXISTS payments_tenant ON payments (tenant_id, created_at DESC);

-- Append-only history of every payment.
CREATE TABLE IF NOT EXISTS payment_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id TEXT NOT NULL,
  version    INTEGER,                           -- the payment version this event produced (null for notes that change nothing)
  type       TEXT NOT NULL,                     -- created | accepted | completed | failed | expired | mismatch | unknown | resolved | late_completion ...
  actor      TEXT NOT NULL,                     -- provider | reconcile | callback | admin:<name> | tenant
  detail     TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS payment_events_payment ON payment_events (payment_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS payment_events_version ON payment_events (payment_id, version) WHERE version IS NOT NULL;

-- Outbox of events to deliver to tenants: written in the same batch as the state change, so an event is never lost and never invented.
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id              TEXT PRIMARY KEY,             -- evt_...: the event id the tenant sees, stable across retries (their dedupe key)
  tenant_id       TEXT NOT NULL,
  payment_id      TEXT NOT NULL,
  type            TEXT NOT NULL,                -- payment.completed | payment.failed | payment.expired | payment.mismatch | payment.unknown
  payload         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',   -- pending | delivered | dead
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  last_status     INTEGER,
  last_error      TEXT,
  created_at      INTEGER NOT NULL,
  delivered_at    INTEGER
);
CREATE INDEX IF NOT EXISTS webhook_due ON webhook_deliveries (status, next_attempt_at);
CREATE INDEX IF NOT EXISTS webhook_payment ON webhook_deliveries (payment_id);

-- Every provider callback as it arrived (bounded), so an unexpected payload can be read later.
CREATE TABLE IF NOT EXISTS provider_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  provider    TEXT NOT NULL,
  path        TEXT NOT NULL,
  accepted    INTEGER NOT NULL,                 -- 1 = signature and shape were good
  body        TEXT NOT NULL,
  received_at INTEGER NOT NULL
);
