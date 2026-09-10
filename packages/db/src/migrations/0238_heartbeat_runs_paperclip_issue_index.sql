-- ALM-8436: valuesForIssue() (server/src/services/run-secret-redaction.ts) ORs
-- context_snapshot ->> 'issueId' against context_snapshot -> 'paperclipIssue' ->> 'id'.
-- The first branch is indexed by heartbeat_runs_company_ctx_issue_created_idx; the second
-- was not, so Postgres could not BitmapOr and fell back to a Seq Scan that detoasted every
-- context_snapshot JSONB blob. IF NOT EXISTS because this index was applied out-of-band on
-- at least one live host during triage under the same name.
CREATE INDEX IF NOT EXISTS "heartbeat_runs_company_ctx_paperclip_issue_idx" ON "heartbeat_runs" USING btree ("company_id",("context_snapshot" -> 'paperclipIssue' ->> 'id'));
