import "../setup-env.js";
import { randomUUID } from "node:crypto";
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
  validBatchPayload,
  type TestServer,
} from "../helpers/server.js";

interface EmailItem {
  id: string;
  batchId: string;
  senderId: string | null;
  recipient: string;
  recipientName: string | null;
  subject: string;
  status: string;
  scheduledAt: string;
  sentAt: string | null;
  lastError: string | null;
  createdAt: string;
}

interface ListResponse {
  data: EmailItem[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}

interface DetailResponse {
  email: EmailItem & { providerMessageId: string | null };
}

interface ErrorResponse {
  error: { code: string; message: string; details: unknown[]; requestId: string };
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

test("lists a batch's emails with pagination and no message body", async () => {
  await withFixture(async ({ sender }) => {
    const created = await api<{ batchId: string; recipientCount: number }>(
      server.baseUrl,
      "/api/batches",
      { method: "POST", body: validBatchPayload(sender.id) },
    );
    assert.equal(created.status, 201);

    const all = await api<ListResponse>(
      server.baseUrl,
      `/api/emails?batchId=${created.body.batchId}&limit=100`,
    );
    assert.equal(all.status, 200);
    assert.equal(all.body.pagination.total, 2);

    const alice = all.body.data.find((e) => e.recipient === "alice@example.com");
    assert.ok(alice, "alice's email should be listed");
    assert.equal(alice.recipientName, "Alice");
    assert.equal(alice.subject, "Hello Alice");
    assert.equal(alice.status, "scheduled");
    assert.equal(alice.batchId, created.body.batchId);
    // The full body must not be exposed in list responses.
    assert.equal(Object.prototype.hasOwnProperty.call(alice, "body"), false);

    // Pagination pages must not overlap.
    const page1 = await api<ListResponse>(
      server.baseUrl,
      `/api/emails?batchId=${created.body.batchId}&limit=1&page=1`,
    );
    assert.equal(page1.body.data.length, 1);
    assert.equal(page1.body.pagination.totalPages, 2);

    const page2 = await api<ListResponse>(
      server.baseUrl,
      `/api/emails?batchId=${created.body.batchId}&limit=1&page=2`,
    );
    const page1Ids = new Set(page1.body.data.map((e) => e.id));
    for (const email of page2.body.data) {
      assert.equal(page1Ids.has(email.id), false);
    }
  });
});

test("filters emails by status, recipient and sender", async () => {
  await withFixture(async ({ user, sender }) => {
    const batch = await insertTestBatch({ userId: user.id, senderId: sender.id });
    const otherBatch = await insertTestBatch({ userId: user.id, senderId: sender.id });

    await insertTestEmail({
      batchId: batch.id,
      senderId: sender.id,
      status: "sent",
      recipient: "filter-target@example.com",
    });
    await insertTestEmail({ batchId: batch.id, senderId: sender.id, status: "failed" });
    await insertTestEmail({ batchId: otherBatch.id, senderId: sender.id, status: "sent" });

    const sent = await api<ListResponse>(server.baseUrl, "/api/emails?status=sent&limit=100");
    assert.equal(sent.body.pagination.total, 2);

    const byRecipient = await api<ListResponse>(
      server.baseUrl,
      "/api/emails?recipient=filter-target@example.com&limit=100",
    );
    assert.equal(byRecipient.body.pagination.total, 1);
    assert.equal(byRecipient.body.data[0]?.status, "sent");

    const byBatch = await api<ListResponse>(
      server.baseUrl,
      `/api/emails?batchId=${batch.id}&limit=100`,
    );
    assert.equal(byBatch.body.pagination.total, 2);

    const bySender = await api<ListResponse>(
      server.baseUrl,
      `/api/emails?senderId=${sender.id}&limit=100`,
    );
    assert.equal(bySender.body.pagination.total, 3);

    const invalidStatus = await api<ErrorResponse>(
      server.baseUrl,
      "/api/emails?status=bogus",
    );
    assert.equal(invalidStatus.status, 400);
    assert.equal(invalidStatus.body.error.code, "VALIDATION_ERROR");
  });
});

test("returns email detail with a sanitized error and no body", async () => {
  await withFixture(async ({ user, sender }) => {
    const batch = await insertTestBatch({ userId: user.id, senderId: sender.id });
    const email = await insertTestEmail({
      batchId: batch.id,
      senderId: sender.id,
      status: "failed",
      lastError: "535 auth failed password=hunter2",
      providerMessageId: "provider-msg-1",
    });

    const detail = await api<DetailResponse>(server.baseUrl, `/api/emails/${email.id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.email.id, email.id);
    assert.equal(detail.body.email.providerMessageId, "provider-msg-1");
    assert.equal(Object.prototype.hasOwnProperty.call(detail.body.email, "body"), false);
    assert.ok(detail.body.email.lastError);
    assert.equal(detail.body.email.lastError.includes("hunter2"), false);

    const unknown = await api<ErrorResponse>(server.baseUrl, `/api/emails/${randomUUID()}`);
    assert.equal(unknown.status, 404);
  });
});

test("never returns another user's emails", async () => {
  await withFixture(async ({ user, sender }) => {
    const batch = await insertTestBatch({ userId: user.id, senderId: sender.id });
    const email = await insertTestEmail({ batchId: batch.id, senderId: sender.id });

    const other = await createTestUser();
    await createTestSender(other.id);
    actAs(other.id);

    try {
      const detail = await api<ErrorResponse>(server.baseUrl, `/api/emails/${email.id}`);
      assert.equal(detail.status, 404);

      const list = await api<ListResponse>(server.baseUrl, "/api/emails?limit=100");
      assert.equal(list.body.pagination.total, 0);
      assert.equal(list.body.data.some((e) => e.id === email.id), false);
    } finally {
      await cleanupTestUser(other.id);
    }
  });
});
