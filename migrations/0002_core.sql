-- Ayonix-SNS core tenant model. Expanded from handoff/reference/schema.sql:
-- every tenant row carries workspace_id with UNIQUE(workspace_id,id) and
-- tenant foreign keys use both columns so cross-tenant links are impossible.
-- Timestamps are ISO-8601 UTC text. Money is integer cents.

CREATE TABLE schema_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- Batch guard: `INSERT INTO batch_guards(ok) SELECT NULL WHERE changes() = 0`
-- placed after a conditional UPDATE aborts the whole D1 batch transaction when
-- the update matched no row (compare-and-swap inside an atomic batch). It is
-- never populated.
CREATE TABLE batch_guards(ok INTEGER NOT NULL);
INSERT INTO schema_meta(key, value) VALUES ('schema_version', '2');

CREATE TABLE workspaces(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 120),
  timezone TEXT NOT NULL DEFAULT 'Australia/Melbourne',
  locale TEXT NOT NULL DEFAULT 'en-AU',
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended','deleting','deleted')),
  trial_used INTEGER NOT NULL DEFAULT 0 CHECK(trial_used IN (0,1)),
  policy_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

-- Application identity mirrors the auth user; id = "user".id.
CREATE TABLE identities(
  id TEXT PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE memberships(
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  identity_id TEXT NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('owner','admin','editor','viewer')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id, identity_id)
);
CREATE INDEX memberships_identity ON memberships(identity_id);

CREATE TABLE invitations(
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','editor','viewer')),
  token_hash TEXT NOT NULL UNIQUE,
  invited_by TEXT NOT NULL REFERENCES identities(id),
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(workspace_id, id)
);

CREATE TABLE products(
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 200),
  audience TEXT NOT NULL DEFAULT '',
  language TEXT NOT NULL DEFAULT 'en',
  tone TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','approved','paused')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  approved_version INTEGER CHECK(approved_version IS NULL OR approved_version <= version),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(workspace_id, id)
);

CREATE TABLE product_revisions(
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0),
  snapshot_json TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL,
  created_by TEXT,
  approved_by TEXT,
  approved_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(workspace_id, product_id) REFERENCES products(workspace_id, id),
  UNIQUE(workspace_id, product_id, version),
  UNIQUE(workspace_id, id)
);

CREATE TABLE product_sources(
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  url TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'owned' CHECK(kind IN ('owned','competitor','research')),
  added_by TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(workspace_id, product_id) REFERENCES products(workspace_id, id),
  UNIQUE(workspace_id, product_id, kind, url),
  UNIQUE(workspace_id, id)
);

CREATE TABLE product_claims(
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0),
  text TEXT NOT NULL CHECK(length(trim(text)) > 0),
  kind TEXT NOT NULL CHECK(kind IN ('claim','prohibited')),
  status TEXT NOT NULL DEFAULT 'proposed' CHECK(status IN ('proposed','approved','rejected')),
  source_url TEXT,
  research_job_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(workspace_id, product_id) REFERENCES products(workspace_id, id),
  UNIQUE(workspace_id, id)
);
CREATE INDEX product_claims_product ON product_claims(workspace_id, product_id, version);

CREATE TABLE connections(
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  provider TEXT NOT NULL CHECK(provider IN ('linkedin','facebook','instagram','tiktok','youtube')),
  provider_account_id TEXT NOT NULL,
  account_name TEXT NOT NULL DEFAULT '',
  account_type TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL CHECK(state IN ('disconnected','authorizing','pending_review','connected','expiring','reconnect_required','restricted','error')),
  granted_scopes TEXT NOT NULL DEFAULT '[]',
  token_expires_at TEXT,
  last_verified_at TEXT,
  api_version TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(workspace_id, id),
  UNIQUE(workspace_id, provider, provider_account_id)
);
CREATE INDEX connections_expiry ON connections(state, token_expires_at);

CREATE TABLE connection_capabilities(
  workspace_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('available','pending_review','unavailable')),
  detail TEXT,
  checked_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id, connection_id, capability),
  FOREIGN KEY(workspace_id, connection_id) REFERENCES connections(workspace_id, id) ON DELETE CASCADE
);

-- AES-GCM ciphertext only; AAD = workspace_id:connection_id:kind.
CREATE TABLE encrypted_credentials(
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('access','refresh','page_access')),
  ciphertext TEXT NOT NULL,
  nonce TEXT NOT NULL,
  key_version INTEGER NOT NULL CHECK(key_version > 0),
  expires_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(workspace_id, connection_id) REFERENCES connections(workspace_id, id) ON DELETE CASCADE,
  UNIQUE(workspace_id, connection_id, kind)
);

-- Provider OAuth initiation state (state + PKCE verifier, encrypted).
CREATE TABLE oauth_states(
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  identity_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  verifier_ciphertext TEXT,
  verifier_nonce TEXT,
  key_version INTEGER,
  reconnect_connection_id TEXT,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE assets(
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  product_id TEXT,
  r2_key TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  declared_mime TEXT,
  mime TEXT NOT NULL DEFAULT 'application/octet-stream',
  bytes INTEGER NOT NULL DEFAULT 0 CHECK(bytes >= 0),
  max_bytes INTEGER NOT NULL CHECK(max_bytes > 0),
  checksum_sha256 TEXT,
  width INTEGER,
  height INTEGER,
  duration_ms INTEGER,
  validation_state TEXT NOT NULL DEFAULT 'pending' CHECK(validation_state IN ('pending','valid','rejected')),
  validation_error TEXT,
  source TEXT NOT NULL CHECK(source IN ('upload','ingest')),
  source_host TEXT,
  rights_confirmed INTEGER NOT NULL DEFAULT 0 CHECK(rights_confirmed IN (0,1)),
  created_by TEXT,
  retention_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(workspace_id, product_id) REFERENCES products(workspace_id, id),
  UNIQUE(workspace_id, id)
);
CREATE INDEX assets_ws_created ON assets(workspace_id, created_at);

CREATE TABLE campaigns(
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  goal TEXT NOT NULL,
  audience TEXT NOT NULL,
  language TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(workspace_id, product_id) REFERENCES products(workspace_id, id),
  UNIQUE(workspace_id, id)
);

CREATE TABLE posts(
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  current_revision INTEGER NOT NULL DEFAULT 1 CHECK(current_revision > 0),
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(workspace_id, campaign_id) REFERENCES campaigns(workspace_id, id),
  UNIQUE(workspace_id, id)
);

-- One row per destination per post revision; immutable once written.
CREATE TABLE content_revisions(
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision > 0),
  position INTEGER NOT NULL CHECK(position >= 0),
  platform TEXT NOT NULL CHECK(platform IN ('linkedin','facebook','instagram','tiktok','youtube')),
  connection_id TEXT NOT NULL,
  format TEXT NOT NULL CHECK(format IN ('text','link','image','video','reel','carousel','photo')),
  caption TEXT NOT NULL DEFAULT '',
  title TEXT,
  link_url TEXT,
  options_json TEXT NOT NULL DEFAULT '{}',
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(workspace_id, post_id) REFERENCES posts(workspace_id, id),
  FOREIGN KEY(workspace_id, connection_id) REFERENCES connections(workspace_id, id),
  UNIQUE(workspace_id, post_id, revision, position),
  UNIQUE(workspace_id, post_id, revision, connection_id),
  UNIQUE(workspace_id, id)
);

CREATE TABLE post_assets(
  workspace_id TEXT NOT NULL,
  content_revision_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK(position >= 0),
  PRIMARY KEY(workspace_id, content_revision_id, position),
  FOREIGN KEY(workspace_id, content_revision_id) REFERENCES content_revisions(workspace_id, id),
  FOREIGN KEY(workspace_id, asset_id) REFERENCES assets(workspace_id, id)
);

CREATE TABLE quota_periods(
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  source TEXT NOT NULL CHECK(source IN ('trial','subscription')),
  external_ref TEXT,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  allowance INTEGER NOT NULL CHECK(typeof(allowance)='integer' AND allowance >= 0),
  used INTEGER NOT NULL DEFAULT 0 CHECK(typeof(used)='integer' AND used >= 0),
  reserved INTEGER NOT NULL DEFAULT 0 CHECK(typeof(reserved)='integer' AND reserved >= 0),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  CHECK(used + reserved <= allowance),
  CHECK(starts_at < ends_at),
  UNIQUE(workspace_id, id),
  UNIQUE(workspace_id, starts_at)
);

CREATE TABLE schedules(
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','canceled','completed')),
  preview_hash TEXT NOT NULL,
  created_by TEXT,
  created_via TEXT NOT NULL CHECK(created_via IN ('web','mcp')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(workspace_id, id)
);

CREATE TABLE targets(
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  schedule_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision > 0),
  content_revision_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  period_id TEXT NOT NULL,
  platform TEXT NOT NULL CHECK(platform IN ('linkedin','facebook','instagram','tiktok','youtube')),
  format TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('draft','awaiting_approval','scheduled','queued','submitting','processing','retry_wait','reconnect_required','outcome_unknown','published','failed','canceled')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  due_at TEXT NOT NULL,
  local_time TEXT NOT NULL,
  timezone TEXT NOT NULL,
  utc_offset TEXT NOT NULL,
  scheduling_owner TEXT NOT NULL DEFAULT 'ayonix' CHECK(scheduling_owner IN ('ayonix','provider_native')),
  approval_required TEXT CHECK(approval_required IS NULL OR approval_required IN ('tiktok_creator_consent')),
  approval_id TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  claim_owner TEXT,
  claim_expires_at TEXT,
  fencing_token INTEGER NOT NULL DEFAULT 0,
  submission_started_at TEXT,
  provider_post_id TEXT,
  provider_url TEXT,
  last_error_code TEXT,
  last_error_message TEXT,
  hold_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(status <> 'published' OR (provider_post_id IS NOT NULL AND length(trim(provider_post_id)) > 0)),
  FOREIGN KEY(workspace_id, schedule_id) REFERENCES schedules(workspace_id, id),
  FOREIGN KEY(workspace_id, post_id) REFERENCES posts(workspace_id, id),
  FOREIGN KEY(workspace_id, content_revision_id) REFERENCES content_revisions(workspace_id, id),
  FOREIGN KEY(workspace_id, product_id) REFERENCES products(workspace_id, id),
  FOREIGN KEY(workspace_id, connection_id) REFERENCES connections(workspace_id, id),
  FOREIGN KEY(workspace_id, period_id) REFERENCES quota_periods(workspace_id, id),
  UNIQUE(workspace_id, id),
  UNIQUE(workspace_id, id, period_id)
);
CREATE INDEX targets_due ON targets(status, due_at);
CREATE INDEX targets_ws_due ON targets(workspace_id, due_at);
CREATE INDEX targets_schedule ON targets(workspace_id, schedule_id);
CREATE INDEX targets_post ON targets(workspace_id, post_id);

CREATE TABLE approvals(
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('tiktok_creator_consent')),
  content_hash TEXT NOT NULL,
  settings_json TEXT NOT NULL,
  settings_hash TEXT NOT NULL,
  creator_snapshot_json TEXT NOT NULL,
  decision TEXT NOT NULL CHECK(decision IN ('approved','returned_to_draft')),
  decided_by TEXT NOT NULL,
  decided_at TEXT NOT NULL,
  FOREIGN KEY(workspace_id, target_id) REFERENCES targets(workspace_id, id),
  UNIQUE(workspace_id, id)
);

CREATE TABLE quota_ledger(
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  target_id TEXT NOT NULL,
  period_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('reserved','committed','released')),
  operation_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  settled_at TEXT,
  FOREIGN KEY(workspace_id, target_id, period_id) REFERENCES targets(workspace_id, id, period_id),
  FOREIGN KEY(workspace_id, period_id) REFERENCES quota_periods(workspace_id, id),
  UNIQUE(workspace_id, target_id)
);

CREATE TABLE idempotency_records(
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  operation TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id, operation, idempotency_key)
);

CREATE TABLE outbox(
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  target_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision > 0),
  kind TEXT NOT NULL DEFAULT 'dispatch' CHECK(kind IN ('dispatch','poll','reconcile')),
  state TEXT NOT NULL CHECK(state IN ('pending','leased','enqueued','done','dead')),
  next_attempt_at TEXT NOT NULL,
  lease_owner TEXT,
  lease_expires_at TEXT,
  enqueue_attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(workspace_id, target_id) REFERENCES targets(workspace_id, id),
  UNIQUE(workspace_id, target_id, revision, kind)
);
CREATE INDEX outbox_due ON outbox(state, next_attempt_at);

CREATE TABLE attempts(
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  attempt_no INTEGER NOT NULL,
  fencing_token INTEGER NOT NULL,
  phase TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  outcome TEXT,
  error_code TEXT,
  error_message TEXT,
  retry_after_seconds INTEGER,
  correlation_id TEXT,
  FOREIGN KEY(workspace_id, target_id) REFERENCES targets(workspace_id, id),
  UNIQUE(workspace_id, id)
);
CREATE INDEX attempts_target ON attempts(workspace_id, target_id);

CREATE TABLE provider_receipts(
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  remote_id TEXT,
  container_id TEXT,
  publish_id TEXT,
  url TEXT,
  status TEXT NOT NULL CHECK(status IN ('accepted','processing','published','failed','unknown')),
  raw_status TEXT,
  verified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(workspace_id, target_id) REFERENCES targets(workspace_id, id),
  UNIQUE(workspace_id, target_id),
  UNIQUE(workspace_id, id)
);

CREATE TABLE subscriptions(
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL UNIQUE REFERENCES workspaces(id),
  plan TEXT CHECK(plan IS NULL OR plan IN ('trial','basic','standard','premium','custom')),
  status TEXT NOT NULL DEFAULT 'none' CHECK(status IN ('none','trialing','active','past_due','suspended','unpaid','canceled','incomplete','expired')),
  catalog_version TEXT,
  selection_json TEXT,
  unit_amount_cents INTEGER,
  stripe_customer_id TEXT UNIQUE,
  stripe_subscription_id TEXT UNIQUE,
  stripe_price_id TEXT,
  current_period_start TEXT,
  current_period_end TEXT,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  pending_plan TEXT,
  pending_selection_json TEXT,
  pending_effective_at TEXT,
  trial_ends_at TEXT,
  past_due_since TEXT,
  last_event_created INTEGER NOT NULL DEFAULT 0,
  entitlement_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(workspace_id, id)
);

CREATE TABLE billing_quotes(
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  plan TEXT NOT NULL CHECK(plan IN ('basic','standard','premium','custom')),
  catalog_version TEXT NOT NULL,
  selection_json TEXT,
  price_cents INTEGER NOT NULL CHECK(typeof(price_cents)='integer' AND price_cents > 0 AND price_cents <= 100000),
  configuration_hash TEXT NOT NULL,
  stripe_price_id TEXT,
  created_by TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(workspace_id, id)
);

-- Server-created Stripe Prices for canonical Custom configurations.
CREATE TABLE custom_prices(
  configuration_hash TEXT PRIMARY KEY,
  catalog_version TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  selection_json TEXT NOT NULL,
  stripe_price_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE billing_events(
  provider TEXT NOT NULL,
  event_id TEXT NOT NULL,
  workspace_id TEXT REFERENCES workspaces(id),
  type TEXT NOT NULL,
  event_created INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('received','applied','ignored','failed')),
  error TEXT,
  received_at TEXT NOT NULL,
  applied_at TEXT,
  PRIMARY KEY(provider, event_id)
);

CREATE TABLE invoices(
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  stripe_invoice_id TEXT NOT NULL UNIQUE,
  number TEXT,
  status TEXT NOT NULL,
  amount_due_cents INTEGER NOT NULL,
  amount_paid_cents INTEGER NOT NULL,
  subtotal_cents INTEGER,
  tax_cents INTEGER,
  currency TEXT NOT NULL,
  hosted_invoice_url TEXT,
  period_start TEXT,
  period_end TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(workspace_id, id)
);

CREATE TABLE webhook_events(
  provider TEXT NOT NULL,
  event_id TEXT NOT NULL,
  workspace_id TEXT,
  type TEXT NOT NULL,
  received_at TEXT NOT NULL,
  processed_at TEXT,
  PRIMARY KEY(provider, event_id)
);

CREATE TABLE metric_snapshots(
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  target_id TEXT,
  provider TEXT NOT NULL,
  provider_object_id TEXT NOT NULL,
  date TEXT NOT NULL,
  raw_metric TEXT NOT NULL,
  metric TEXT,
  value REAL,
  aggregation TEXT NOT NULL CHECK(aggregation IN ('lifetime','day','period')),
  estimated INTEGER NOT NULL DEFAULT 0,
  schema_version INTEGER NOT NULL DEFAULT 1,
  retrieved_at TEXT NOT NULL,
  FOREIGN KEY(workspace_id, connection_id) REFERENCES connections(workspace_id, id),
  UNIQUE(workspace_id, provider_object_id, raw_metric, date, aggregation)
);
CREATE INDEX metrics_ws_account_date ON metric_snapshots(workspace_id, connection_id, date);
CREATE INDEX metrics_ws_target ON metric_snapshots(workspace_id, target_id);

CREATE TABLE report_jobs(
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  requested_by TEXT NOT NULL,
  format TEXT NOT NULL CHECK(format IN ('csv','pdf')),
  filters_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','running','ready','failed')),
  r2_key TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  expires_at TEXT,
  UNIQUE(workspace_id, id)
);

CREATE TABLE research_jobs(
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  period_id TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('auto_learn','competitor_check','similar_research')),
  question TEXT,
  input_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed','blocked')),
  result_json TEXT,
  error TEXT,
  pages_fetched INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY(workspace_id, product_id) REFERENCES products(workspace_id, id),
  UNIQUE(workspace_id, id)
);
CREATE INDEX research_jobs_product ON research_jobs(workspace_id, product_id, kind, created_at);

CREATE TABLE research_sources(
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT,
  status TEXT NOT NULL CHECK(status IN ('fetched','unavailable','blocked','too_large')),
  content_hash TEXT,
  bytes INTEGER,
  r2_key TEXT,
  retrieved_at TEXT NOT NULL,
  delete_after TEXT NOT NULL,
  FOREIGN KEY(workspace_id, job_id) REFERENCES research_jobs(workspace_id, id),
  UNIQUE(workspace_id, id)
);

CREATE TABLE audit_events(
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  actor_identity_id TEXT,
  actor_type TEXT NOT NULL CHECK(actor_type IN ('user','mcp','system','stripe','provider','staff')),
  action TEXT NOT NULL,
  object_type TEXT NOT NULL,
  object_id TEXT,
  revision INTEGER,
  detail_json TEXT NOT NULL DEFAULT '{}',
  request_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX audit_ws_created ON audit_events(workspace_id, created_at);

CREATE TABLE privacy_jobs(
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  kind TEXT NOT NULL CHECK(kind IN ('export','delete')),
  status TEXT NOT NULL CHECK(status IN ('queued','running','ready','completed','failed')),
  requested_by TEXT NOT NULL,
  r2_key TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(workspace_id, id)
);

CREATE TABLE notification_preferences(
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  identity_id TEXT NOT NULL,
  event TEXT NOT NULL CHECK(event IN ('publish_failed','approval_needed','reconnect_required','payment_failed','weekly_report')),
  email INTEGER NOT NULL DEFAULT 1 CHECK(email IN (0,1)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id, identity_id, event)
);

CREATE TABLE sent_notifications(
  id TEXT PRIMARY KEY,
  workspace_id TEXT,
  identity_id TEXT,
  recipient TEXT NOT NULL,
  template TEXT NOT NULL,
  transport TEXT NOT NULL CHECK(transport IN ('resend','dev_mailbox')),
  status TEXT NOT NULL CHECK(status IN ('sent','failed')),
  provider_message_id TEXT,
  error TEXT,
  dedupe_key TEXT UNIQUE,
  -- Only populated for the development mailbox; production never stores bodies.
  dev_body TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX sent_notifications_created ON sent_notifications(created_at);
