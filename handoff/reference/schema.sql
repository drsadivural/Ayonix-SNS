PRAGMA foreign_keys=ON;
CREATE TABLE workspaces(id TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE products(
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 name TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
 UNIQUE(workspace_id,id)
);
CREATE TABLE connections(
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 provider TEXT NOT NULL CHECK(provider IN('linkedin','facebook','instagram','tiktok','youtube')),
 provider_account_id TEXT NOT NULL,
 UNIQUE(workspace_id,id), UNIQUE(workspace_id,provider,provider_account_id)
);
CREATE TABLE quota_periods(
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 starts_at TEXT NOT NULL, ends_at TEXT NOT NULL,
 allowance INTEGER NOT NULL CHECK(typeof(allowance)='integer' AND allowance>=0),
 used INTEGER NOT NULL DEFAULT 0 CHECK(typeof(used)='integer' AND used>=0),
 reserved INTEGER NOT NULL DEFAULT 0 CHECK(typeof(reserved)='integer' AND reserved>=0),
 CHECK(used+reserved<=allowance), CHECK(starts_at<ends_at),
 UNIQUE(workspace_id,id), UNIQUE(workspace_id,starts_at)
);
CREATE TABLE targets(
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 product_id TEXT NOT NULL, connection_id TEXT NOT NULL, period_id TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN('draft','awaiting_approval','scheduled','queued','submitting','processing','retry_wait','reconnect_required','outcome_unknown','published','failed','canceled')),
 due_at TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
 provider_post_id TEXT,
 CHECK(status<>'published' OR (provider_post_id IS NOT NULL AND length(trim(provider_post_id))>0)),
 FOREIGN KEY(workspace_id,product_id) REFERENCES products(workspace_id,id),
 FOREIGN KEY(workspace_id,connection_id) REFERENCES connections(workspace_id,id),
 FOREIGN KEY(workspace_id,period_id) REFERENCES quota_periods(workspace_id,id),
 UNIQUE(workspace_id,id), UNIQUE(workspace_id,id,period_id)
);
CREATE TABLE quota_ledger(
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 target_id TEXT NOT NULL, period_id TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN('reserved','committed','released')),
 FOREIGN KEY(workspace_id,target_id,period_id) REFERENCES targets(workspace_id,id,period_id),
 FOREIGN KEY(workspace_id,period_id) REFERENCES quota_periods(workspace_id,id),
 UNIQUE(workspace_id,target_id)
);
CREATE TABLE idempotency_records(
 workspace_id TEXT NOT NULL REFERENCES workspaces(id), operation TEXT NOT NULL,
 idempotency_key TEXT NOT NULL, payload_hash TEXT NOT NULL, response_json TEXT NOT NULL,
 PRIMARY KEY(workspace_id,operation,idempotency_key)
);
CREATE TABLE billing_events(
 provider TEXT NOT NULL, event_id TEXT NOT NULL, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 received_at TEXT NOT NULL, applied_at TEXT,
 PRIMARY KEY(provider,event_id)
);
CREATE TABLE outbox(
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), target_id TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision>0), state TEXT NOT NULL CHECK(state IN('pending','leased','enqueued','done')),
 next_attempt_at TEXT NOT NULL,
 FOREIGN KEY(workspace_id,target_id) REFERENCES targets(workspace_id,id),
 UNIQUE(workspace_id,target_id,revision)
);
CREATE INDEX targets_due ON targets(status,due_at);
CREATE INDEX outbox_due ON outbox(state,next_attempt_at);
-- Reference constraints only. Application must transact ledger + counters + outbox
-- together, authenticate every operation and implement the expanded production model.
