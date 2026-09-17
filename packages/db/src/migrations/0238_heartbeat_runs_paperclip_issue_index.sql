-- ALM-8436: valuesForIssue() (server/src/services/run-secret-redaction.ts) ORs
-- context_snapshot ->> 'issueId' against context_snapshot -> 'paperclipIssue' ->> 'id'.
-- The first branch is indexed by heartbeat_runs_company_ctx_issue_created_idx; the second
-- was not, so Postgres could not BitmapOr and fell back to a Seq Scan that detoasted every
-- context_snapshot JSONB blob. IF NOT EXISTS because this index was applied out-of-band on
-- at least one live host during triage under the same name.
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Drizzle migrations run transactionally, so CONCURRENTLY is unavailable. heartbeat_runs is a large table in practice (84,969 rows / 2,151 MB measured 2026-09-11 on the Almwell host, while table-size-estimates.ts still records the 2026-07-06 count of 3,620, so this gate does not fire on its own). The one-time in-transaction build held a SHARE lock on heartbeat_runs for 34.8s on that host and blocked writes for that window. The alternative is a permanent Seq Scan over every context_snapshot blob on the 11 valuesForIssue call sites hit per heartbeat wake, so the bounded build lock is the lesser cost.
CREATE INDEX IF NOT EXISTS "heartbeat_runs_company_ctx_paperclip_issue_idx" ON "heartbeat_runs" USING btree ("company_id",("context_snapshot" -> 'paperclipIssue' ->> 'id'));
