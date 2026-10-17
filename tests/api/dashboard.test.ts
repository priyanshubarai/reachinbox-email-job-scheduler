import "../setup-env.js";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { closeDb } from "../../src/db/index.js";
import {
  cleanupTestUser,
  createTestSender,
  createTestUser,
  insertTestBatch,
  insertTestEmail,
  type TestSender,
  type TestUser,
} from "../helpers/db.js";
import {
  actAs,
  actAsNobody,
  api,
  startTestServer,
  type TestServer,
} from "../helpers/server.js";

interface DashboardStats {
  generatedAt: string;
  totals: { batches: number; emails: number };
  byStatus: Record<string, number>;
  sentLast24Hours: number;
  scheduled: number;
  failed: number;
  perSender: Array<{
    senderId: string | null;
    fromEmail: string | null;
    fromName: string | null;
    emails: number;
    sent: number;
  }>;
  source: string;
}

let server: TestServer;

before(async () => {
  server = await startTestServer();
});

after(async () => {
  await server.close();
  await closeDb();
});

async function withFixture<T>(
  fn: (ctx: { user: TestUser; sender: TestSender }) => Promise<T>,
): Promise<T> {
  const user = await createTestUser();
  const sender = await createTestSender(user.id);
  actAs(user.id);

  try {
    return await fn({ user, sender });
  } finally {
    actAsNobody();
    await cleanupTestUser(user.id);
  }
}

test("aggregates batch, status and sender statistics", async () => {
  await withFixture(async ({ user, sender }) => {
    const batch = await insertTestBatch({ userId: user.id, senderId: sender.id });
    const now = new Date();
    const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);

    await insertTestEmail({ batchId: batch.id, senderId: sender.id, status: "scheduled" });
    await insertTestEmail({
      batchId: batch.id,
      senderId: sender.id,
      status: "sent",
      sentAt: now,
    });
    await insertTestEmail({
      batchId: batch.id,
      senderId: sender.id,
      status: "sent",
      sentAt: threeDaysAgo,
    });
    await insertTestEmail({ batchId: batch.id, senderId: sender.id, status: "failed" });
    await insertTestEmail({ batchId: batch.id, senderId: sender.id, status: "unknown" });
    await insertTestEmail({ batchId: batch.id, senderId: sender.id, status: "sending" });

    const res = await api<DashboardStats>(server.baseUrl, "/api/dashboard/stats");
    assert.equal(res.status, 200);

    assert.equal(res.body.totals.batches, 1);
    assert.equal(res.body.totals.emails, 6);
    assert.equal(res.body.byStatus.scheduled, 1);
    assert.equal(res.body.byStatus.sending, 1);
    assert.equal(res.body.byStatus.sent, 2);
    assert.equal(res.body.byStatus.failed, 1);
    assert.equal(res.body.byStatus.unknown, 1);

    // Only the email sent within the last 24h counts here.
    assert.equal(res.body.sentLast24Hours, 1);
    assert.equal(res.body.scheduled, 1);
    assert.equal(res.body.failed, 1);
    assert.equal(res.body.source, "database");
    assert.equal(Number.isNaN(Date.parse(res.body.generatedAt)), false);

    assert.equal(res.body.perSender.length, 1);
    const senderStats = res.body.perSender[0]!;
    assert.equal(senderStats.senderId, sender.id);
    assert.equal(senderStats.fromEmail, sender.fromEmail);
    assert.equal(senderStats.emails, 6);
    assert.equal(senderStats.sent, 2);
  });
});

test("returns zeroed statistics for a user with no data", async () => {
  await withFixture(async () => {
    const res = await api<DashboardStats>(server.baseUrl, "/api/dashboard/stats");
    assert.equal(res.status, 200);
    assert.equal(res.body.totals.batches, 0);
    assert.equal(res.body.totals.emails, 0);
    assert.equal(res.body.sentLast24Hours, 0);
    assert.equal(res.body.perSender.length, 0);
    assert.equal(res.body.byStatus.scheduled, 0);
    assert.equal(res.body.byStatus.sent, 0);
  });
});
