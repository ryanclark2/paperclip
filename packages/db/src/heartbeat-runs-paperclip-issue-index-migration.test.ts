import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it, afterEach } from "vitest";
import postgres from "postgres";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

// ALM-8436: valuesForIssue() in server/src/services/run-secret-redaction.ts ORs
// context_snapshot ->> 'issueId' (indexed since 0209) against
// context_snapshot -> 'paperclipIssue' ->> 'id'. Without an index on the second
// branch Postgres cannot BitmapOr and seq-scans heartbeat_runs, detoasting every
// context_snapshot blob (52s on an 84k-row / 2.1 GB table). 0238 adds that index.
// This test is the durability guard the ticket asks for: a fresh database must
// build the index in exactly this shape, and the production query shape must plan
// through it. Asserting the full definition (not name membership) matters because
// CREATE INDEX IF NOT EXISTS matches on name only — a same-named index of another
// shape would be accepted silently and leave the seq scan in place.

const INDEX_NAME = "heartbeat_runs_company_ctx_paperclip_issue_idx";
const SIBLING_INDEX_NAME = "heartbeat_runs_company_ctx_issue_created_idx";
const EXPECTED_INDEXDEF =
  `CREATE INDEX ${INDEX_NAME} ON public.heartbeat_runs USING btree ` +
  "(company_id, (((context_snapshot -> 'paperclipIssue'::text) ->> 'id'::text)))";

const COMPANY_ID = "00000000-0000-0000-0000-000000000001";
const AGENT_ID = "00000000-0000-0000-0000-000000000002";
const ISSUE_ID = "00000000-0000-0000-0000-000000000003";
const SEED_ROWS = 5_000;
// Same predicate valuesForIssue() emits, written out so the plan is checked
// against the production shape rather than a hand-simplified one.
const VALUES_FOR_ISSUE_EXPLAIN =
  "EXPLAIN SELECT context_snapshot FROM heartbeat_runs " +
  `WHERE company_id = '${COMPANY_ID}' ` +
  `AND (context_snapshot ->> 'issueId' = '${ISSUE_ID}' ` +
  `OR context_snapshot -> 'paperclipIssue' ->> 'id' = '${ISSUE_ID}')`;

const cleanups: Array<() => Promise<void>> = [];
const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function indexDefinition(sql: postgres.Sql, name: string): Promise<string | null> {
  const rows = await sql<{ indexdef: string }[]>`
    SELECT pg_get_indexdef(c.oid) AS indexdef
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'i' AND n.nspname = 'public' AND c.relname = ${name}
  `;
  return rows[0]?.indexdef ?? null;
}

async function explainText(sql: postgres.Sql, query: string): Promise<string> {
  const plan = await sql.unsafe(query);
  return plan.map((r) => Object.values(r)[0]).join("\n");
}

d("heartbeat_runs paperclipIssue expression index migration (0238)", () => {
  it("builds the index in exactly the shape valuesForIssue() needs and plans the OR through it", async () => {
    const dbh = await startEmbeddedPostgresTestDatabase("pap8436-idx-");
    cleanups.push(() => dbh.cleanup());
    const sql = postgres(dbh.connectionString, { max: 1 });
    cleanups.push(async () => { await sql.end(); });

    // Definition equality, not name membership (see header).
    expect(await indexDefinition(sql, INDEX_NAME)).toBe(EXPECTED_INDEXDEF);

    // The production query shape must reach both branches by index. Seed enough
    // rows that the planner has a real choice: on an empty table it takes a
    // company_id prefix scan with the OR as a Filter, which proves nothing about
    // the expression index. FK checks are skipped (superuser) so the seed needs no
    // companies/agents rows; the planner only reads heartbeat_runs statistics.
    await sql.unsafe("SET session_replication_role = replica");
    await sql.unsafe(`
      INSERT INTO heartbeat_runs (company_id, agent_id, context_snapshot)
      SELECT '${COMPANY_ID}'::uuid,
             '${AGENT_ID}'::uuid,
             CASE WHEN g % 2 = 0
               THEN jsonb_build_object('issueId', gen_random_uuid()::text)
               ELSE jsonb_build_object('paperclipIssue', jsonb_build_object('id', gen_random_uuid()::text))
             END
      FROM generate_series(1, ${SEED_ROWS}) AS g
    `);
    await sql.unsafe("SET session_replication_role = origin");
    await sql.unsafe("ANALYZE heartbeat_runs");

    const planText = await explainText(sql, VALUES_FOR_ISSUE_EXPLAIN);
    expect(planText).toContain("BitmapOr");
    expect(planText).toContain(`Bitmap Index Scan on ${INDEX_NAME}`);
    expect(planText).toContain(`Bitmap Index Scan on ${SIBLING_INDEX_NAME}`);
    expect(planText).not.toContain("Seq Scan");

    // Idempotency: the live host already carries this index (created by hand
    // during triage under the same name), so the migration must be a no-op there.
    const migrationSql = await readFile(
      fileURLToPath(new URL("./migrations/0238_heartbeat_runs_paperclip_issue_index.sql", import.meta.url)),
      "utf8",
    );
    const statements = migrationSql
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) {
      await sql.unsafe(statement);
    }
    expect(await indexDefinition(sql, INDEX_NAME)).toBe(EXPECTED_INDEXDEF);
  }, 240_000);
});
