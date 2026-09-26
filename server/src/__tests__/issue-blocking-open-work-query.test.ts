import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  issueRelations,
  issues,
} from "@paperclipai/db";
import { ISSUE_RELATION_TYPES, ISSUE_STATUSES } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  listIssueIdsBlockingOpenWork,
  OPEN_WORK_EXCLUDED_ISSUE_STATUSES,
} from "../services/issues.ts";

/**
 * Direct cover for the blocking-set query behind the queued-run dispatch head
 * start. The dispatcher-level suite
 * (./heartbeat-blocking-head-start-dispatch.test.ts) proves the call site is
 * wired to this function; this one proves the function itself, one predicate at
 * a time, without a heartbeat run in the way.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres blocking-set query tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function ensureIssueRelationsTable(db: ReturnType<typeof createDb>) {
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS "issue_relations" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "company_id" uuid NOT NULL,
      "issue_id" uuid NOT NULL,
      "related_issue_id" uuid NOT NULL,
      "type" text NOT NULL,
      "created_by_agent_id" uuid,
      "created_by_user_id" text,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now()
    );
  `));
}

describeEmbeddedPostgres("listIssueIdsBlockingOpenWork", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-blocking-open-work-query-");
    db = createDb(tempDb.connectionString);
    await ensureIssueRelationsTable(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `Q${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    return companyId;
  }

  async function seedIssue(companyId: string, title: string, status: string) {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId,
      title,
      status,
      priority: "high",
      responsibleUserId: "responsible-user",
    });
    return id;
  }

  async function seedBlocksEdge(companyId: string, blockerId: string, dependentId: string) {
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerId,
      relatedIssueId: dependentId,
      type: "blocks",
    });
  }

  it("selects the blocker, never the dependent, and never an id it was not asked for", async () => {
    const companyId = await seedCompany();
    const blockerId = await seedIssue(companyId, "Blocker", "todo");
    const dependentId = await seedIssue(companyId, "Dependent", "todo");
    const unaskedBlockerId = await seedIssue(companyId, "Unasked blocker", "todo");
    const unaskedDependentId = await seedIssue(companyId, "Unasked dependent", "todo");
    await seedBlocksEdge(companyId, blockerId, dependentId);
    await seedBlocksEdge(companyId, unaskedBlockerId, unaskedDependentId);

    // The dependent is in the asked-for list too, so reversing the direction
    // returns it instead of the blocker rather than returning nothing.
    const result = await listIssueIdsBlockingOpenWork(db, companyId, [
      blockerId,
      dependentId,
    ]);
    expect([...result]).toEqual([blockerId]);
  });

  it("counts a dependent as open work for exactly the statuses outside the exclusion list", async () => {
    const companyId = await seedCompany();
    const blockerByStatus = new Map<string, string>();
    for (const status of ISSUE_STATUSES) {
      const blockerId = await seedIssue(companyId, `Blocker of a ${status} dependent`, "todo");
      const dependentId = await seedIssue(companyId, `Dependent (${status})`, status);
      await seedBlocksEdge(companyId, blockerId, dependentId);
      blockerByStatus.set(status, blockerId);
    }

    const result = await listIssueIdsBlockingOpenWork(db, companyId, [
      ...blockerByStatus.values(),
    ]);
    // Equality over the whole status enum: narrowing or widening the exclusion
    // list moves exactly one row here (ADR-004 Amendment 6).
    expect(
      ISSUE_STATUSES.map((status) => [status, result.has(blockerByStatus.get(status)!)]),
    ).toEqual([
      ["backlog", false],
      ["todo", true],
      ["in_progress", true],
      ["in_review", true],
      ["done", false],
      ["blocked", true],
      ["cancelled", false],
    ]);
  });

  it("ignores an edge whose dependent belongs to another company", async () => {
    const companyId = await seedCompany();
    const otherCompanyId = await seedCompany();
    const blockerId = await seedIssue(companyId, "Blocker", "todo");
    const foreignDependentId = await seedIssue(otherCompanyId, "Foreign dependent", "todo");
    // The relation row is scoped to this company; only the dependent is not.
    await seedBlocksEdge(companyId, blockerId, foreignDependentId);

    const result = await listIssueIdsBlockingOpenWork(db, companyId, [blockerId]);
    expect([...result]).toEqual([]);
  });

  it("ignores an edge scoped to another company", async () => {
    const companyId = await seedCompany();
    const otherCompanyId = await seedCompany();
    const blockerId = await seedIssue(companyId, "Blocker", "todo");
    const dependentId = await seedIssue(companyId, "Dependent", "todo");
    await seedBlocksEdge(otherCompanyId, blockerId, dependentId);

    const result = await listIssueIdsBlockingOpenWork(db, companyId, [blockerId]);
    expect([...result]).toEqual([]);
  });

  it("returns an empty set for an empty id list", async () => {
    const companyId = await seedCompany();
    const blockerId = await seedIssue(companyId, "Blocker", "todo");
    const dependentId = await seedIssue(companyId, "Dependent", "todo");
    await seedBlocksEdge(companyId, blockerId, dependentId);

    expect([...(await listIssueIdsBlockingOpenWork(db, companyId, []))]).toEqual([]);
  });

  it("pins the exclusion list, and records why the relation-type predicate has no negative fixture", () => {
    expect([...OPEN_WORK_EXCLUDED_ISSUE_STATUSES]).toEqual([
      "backlog",
      "done",
      "cancelled",
    ]);
    // The query also filters `issueRelations.type = "blocks"`. That predicate
    // has no negative fixture here because the schema admits exactly one
    // relation type and rejects any other at insert time, so a wrong-type row
    // is not constructible. When a second type is added this assertion fails,
    // which is the signal to write the fixture that predicate then needs.
    expect([...ISSUE_RELATION_TYPES]).toEqual(["blocks"]);
  });
});
