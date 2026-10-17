import "../setup-env.js";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { closeDb } from "../../src/db/index.js";
import { buildEmailIdempotencyKey } from "../../src/services/batch.service.js";
import {
  cleanupTestUser,
  countBatchesBySubject,
  countEmailsByIdempotencyKey,
  countOutboxEventsForBatch,
  createTestSender,
  createTestUser,
  getEmailsForBatch,
  insertTestBatch,
  insertTestEmail,
  type TestSender,
  type TestUser,
} from "../helpers/db.js";
import {
  actAs,
  actAsNobody,
  api,
  findQueueJobsForEmails,
  startTestServer,
  validBatchPayload,
  type TestServer,
} from "../helpers/server.js";

interface CreateBatchResponse {
  message: string;
  batchId: string;
  recipientCount: number;
  schedulingSummary: {
    idempotencyKey: string;
    startAt: string;
    delayMs: number;
    hourlyLimit: number;
    firstScheduledAt: string;
    lastScheduledAt: string;
    outboxEventsCreated: number;
  };
  idempotentReplay?: boolean;
}

interface ErrorResponse {
  error: {
    code: string;
    message: string;
    details: Array<{ path: string; message: string }>;
    requestId: string;
  };
}

let server: TestServer;

before(async () => {
  server = await startTestServer();
});

after(async () => {
  await server.close();
  await closeDb();
});

/**
 * Runs a test body as a fresh user + sender, then removes every row it created.
 * Activating a real identity per test keeps ownership assertions honest.
 */
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

test("creates a batch with rendered emails and outbox events", async () => {
  await withFixture(async ({ sender }) => {
    const payload = validBatchPayload(sender.id);
    const res = await api<CreateBatchResponse>(server.baseUrl, "/api/batches", {
      method: "POST",
      body: payload,
    });

    assert.equal(res.status, 201);
    assert.equal(res.body.recipientCount, 2);
    assert.equal(res.body.schedulingSummary.outboxEventsCreated, 2);
    assert.equal(res.body.schedulingSummary.delayMs, 1000);
    assert.equal(res.body.schedulingSummary.hourlyLimit, 100);
    assert.equal(res.body.idempotentReplay, undefined);

    const first = Date.parse(res.body.schedulingSummary.firstScheduledAt);
    const last = Date.parse(res.body.schedulingSummary.lastScheduledAt);
    assert.equal(last - first, 1000);

    const emails = await getEmailsForBatch(res.body.batchId);
    assert.equal(emails.length, 2);
    assert.equal(emails[0]?.recipient, "alice@example.com");
    assert.equal(emails[0]?.recipientName, "Alice");
    assert.equal(emails[0]?.subject, "Hello Alice");
    assert.equal(emails[0]?.body, "Hi Alice, your address is alice@example.com.");
    assert.equal(emails[0]?.status, "scheduled");
    assert.equal(emails[1]?.subject, "Hello Bob");

    assert.equal(await countOutboxEventsForBatch(res.body.batchId), 2);

    // The API must never publish a BullMQ job for these emails; only the outbox
    // dispatcher may. Queue-level keys left by other suites are ignored — a
    // leaked job appears as a key containing the email id.
    const leakedJobs = await findQueueJobsForEmails(emails.map((email) => email.id));
    assert.deepEqual(leakedJobs ?? [], []);
  });
});

test("rejects invalid recipients and invalid schedules with a 400 envelope", async () => {
  await withFixture(async ({ sender }) => {
    const cases: Array<{ label: string; body: Record<string, unknown> }> = [
      { label: "invalid recipient", body: validBatchPayload(sender.id, { recipients: ["not-an-email"] }) },
      { label: "empty recipients", body: validBatchPayload(sender.id, { recipients: [] }) },
      { label: "missing sender", body: validBatchPayload(sender.id, { senderId: undefined }) },
      {
        label: "past start",
        body: validBatchPayload(sender.id, { startAt: new Date(Date.now() - 3_600_000).toISOString() }),
      },
      { label: "bad delay", body: validBatchPayload(sender.id, { delayMs: -5 }) },
      { label: "non-numeric limit", body: validBatchPayload(sender.id, { hourlyLimit: "many" }) },
      { label: "duplicate recipients", body: validBatchPayload(sender.id, { recipients: ["a@x.com", "A@X.com"] }) },
    ];

    for (const testCase of cases) {
      const res = await api<ErrorResponse>(server.baseUrl, "/api/batches", {
        method: "POST",
        body: testCase.body,
      });

      assert.equal(res.status, 400, `${testCase.label} should be rejected`);
      assert.equal(res.body.error.code, "VALIDATION_ERROR");
      assert.ok(res.body.error.details.length > 0, `${testCase.label} should report field details`);
      assert.equal(typeof res.body.error.requestId, "string");
    }
  });
});

test("rejects a nonexistent, inactive or foreign sender", async () => {
  await withFixture(async ({ user }) => {
    const missing = await api<ErrorResponse>(server.baseUrl, "/api/batches", {
      method: "POST",
      body: validBatchPayload(randomUUID()),
    });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, "NOT_FOUND");

    // Inactive sender owned by the acting user -> 409.
    const inactiveSender = await createTestSender(user.id, { isActive: false });

    // Active sender owned by someone else -> must look missing (404).
    const foreign = await createTestUser();
    const foreignSender = await createTestSender(foreign.id);

    try {
      const inactiveRes = await api<ErrorResponse>(server.baseUrl, "/api/batches", {
        method: "POST",
        body: validBatchPayload(inactiveSender.id),
      });
      assert.equal(inactiveRes.status, 409);
      assert.equal(inactiveRes.body.error.code, "CONFLICT");

      const foreignRes = await api<ErrorResponse>(server.baseUrl, "/api/batches", {
        method: "POST",
        body: validBatchPayload(foreignSender.id),
      });
      // Another user's sender must be indistinguishable from a missing one.
      assert.equal(foreignRes.status, 404);
      assert.equal(foreignRes.body.error.code, "NOT_FOUND");
    } finally {
      await cleanupTestUser(foreign.id);
    }
  });
});

test("rolls back the whole transaction when email creation fails", async () => {
  await withFixture(async ({ user, sender }) => {
    const key = `rollback-${randomUUID().slice(0, 8)}`;
    const subject = `Rollback batch ${randomUUID().slice(0, 8)}`;
    const fixtureBatch = await insertTestBatch({
      userId: user.id,
      senderId: sender.id,
    });

    // Occupy `key:1` so the second email insert inside the new transaction
    // collides and forces a rollback of the batch + first email.
    await insertTestEmail({
      batchId: fixtureBatch.id,
      senderId: sender.id,
      idempotencyKey: buildEmailIdempotencyKey(user.id, key, 1),
    });

    const res = await api<ErrorResponse>(server.baseUrl, "/api/batches", {
      method: "POST",
      headers: { "idempotency-key": key },
      body: validBatchPayload(sender.id, { subject }),
    });

    assert.equal(res.status, 500);
    assert.equal(res.body.error.code, "INTERNAL_ERROR");
    assert.equal(JSON.stringify(res.body).includes("stack"), false);

    assert.equal(await countBatchesBySubject(subject), 0);
    assert.equal(
      await countEmailsByIdempotencyKey(buildEmailIdempotencyKey(user.id, key, 0)),
      0,
    );
    // The pre-existing colliding row is untouched.
    assert.equal(
      await countEmailsByIdempotencyKey(buildEmailIdempotencyKey(user.id, key, 1)),
      1,
    );
  });
});

test("replays an idempotent request instead of creating a duplicate batch", async () => {
  await withFixture(async ({ user, sender }) => {
    const headerKey = `hdr-${randomUUID().slice(0, 8)}`;
    const subject = `Idempotent ${randomUUID().slice(0, 8)}`;
    const payload = validBatchPayload(sender.id, { subject });

    const first = await api<CreateBatchResponse>(server.baseUrl, "/api/batches", {
      method: "POST",
      headers: { "idempotency-key": headerKey },
      body: payload,
    });
    assert.equal(first.status, 201);

    const second = await api<CreateBatchResponse>(server.baseUrl, "/api/batches", {
      method: "POST",
      headers: { "idempotency-key": headerKey },
      body: payload,
    });
    assert.equal(second.status, 200);
    assert.equal(second.body.idempotentReplay, true);
    assert.equal(second.body.batchId, first.body.batchId);

    // Body-provided key path.
    const bodyKey = `body-${randomUUID().slice(0, 8)}`;
    const bodyPayload = validBatchPayload(sender.id, {
      subject: `BodyKey ${randomUUID().slice(0, 8)}`,
      idempotencyKey: bodyKey,
    });
    const bodyFirst = await api<CreateBatchResponse>(server.baseUrl, "/api/batches", {
      method: "POST",
      body: bodyPayload,
    });
    const bodySecond = await api<CreateBatchResponse>(server.baseUrl, "/api/batches", {
      method: "POST",
      body: bodyPayload,
    });
    assert.equal(bodyFirst.status, 201);
    assert.equal(bodySecond.status, 200);
    assert.equal(bodySecond.body.idempotentReplay, true);
    assert.equal(bodySecond.body.batchId, bodyFirst.body.batchId);

    assert.equal(await countBatchesBySubject(subject), 1);
    assert.equal(
      await countEmailsByIdempotencyKey(buildEmailIdempotencyKey(user.id, headerKey, 0)),
      1,
    );
    assert.equal(await countOutboxEventsForBatch(first.body.batchId), 2);
  });
});

test("two users may use the same idempotency key independently", async () => {
  const sharedKey = `shared-${randomUUID().slice(0, 8)}`;
  const userA = await createTestUser();
  const senderA = await createTestSender(userA.id);
  const userB = await createTestUser();
  const senderB = await createTestSender(userB.id);

  try {
    actAs(userA.id);
    const resA = await api<CreateBatchResponse>(server.baseUrl, "/api/batches", {
      method: "POST",
      headers: { "idempotency-key": sharedKey },
      body: validBatchPayload(senderA.id),
    });
    assert.equal(resA.status, 201);

    actAs(userB.id);
    const resB = await api<CreateBatchResponse>(server.baseUrl, "/api/batches", {
      method: "POST",
      headers: { "idempotency-key": sharedKey },
      body: validBatchPayload(senderB.id),
    });
    // Same client key, different account: must succeed, not collide.
    assert.equal(resB.status, 201);
    assert.notEqual(resB.body.batchId, resA.body.batchId);

    // Each user replays only their own batch.
    actAs(userA.id);
    const replayA = await api<CreateBatchResponse>(server.baseUrl, "/api/batches", {
      method: "POST",
      headers: { "idempotency-key": sharedKey },
      body: validBatchPayload(senderA.id),
    });
    assert.equal(replayA.status, 200);
    assert.equal(replayA.body.batchId, resA.body.batchId);
  } finally {
    actAsNobody();
    await cleanupTestUser(userA.id);
    await cleanupTestUser(userB.id);
  }
});

test("lists batches with stable pagination and sender filtering", async () => {
  await withFixture(async ({ sender }) => {
    const created: string[] = [];

    for (let i = 0; i < 3; i += 1) {
      const res = await api<CreateBatchResponse>(server.baseUrl, "/api/batches", {
        method: "POST",
        body: validBatchPayload(sender.id, {
          subject: `Page ${i} ${randomUUID().slice(0, 8)}`,
        }),
      });
      assert.equal(res.status, 201);
      created.push(res.body.batchId);
    }

    const otherSender = await createTestSender(sender.userId);
    const otherBatch = await api<CreateBatchResponse>(server.baseUrl, "/api/batches", {
      method: "POST",
      body: validBatchPayload(otherSender.id, {
        subject: `Other ${randomUUID().slice(0, 8)}`,
      }),
    });
    assert.equal(otherBatch.status, 201);

    interface ListResponse {
      data: Array<{ id: string; createdAt: string; senderId: string | null }>;
      pagination: { page: number; limit: number; total: number; totalPages: number };
    }

    const page1 = await api<ListResponse>(server.baseUrl, "/api/batches?limit=2&page=1");
    assert.equal(page1.status, 200);
    assert.equal(page1.body.data.length, 2);
    assert.equal(page1.body.pagination.total, 4);
    assert.equal(page1.body.pagination.totalPages, 2);

    const page2 = await api<ListResponse>(server.baseUrl, "/api/batches?limit=2&page=2");
    assert.equal(page2.status, 200);
    assert.equal(page2.body.data.length, 2);

    const page1Ids = new Set(page1.body.data.map((b) => b.id));
    for (const batch of page2.body.data) {
      assert.equal(page1Ids.has(batch.id), false, "pages must not overlap");
    }

    const times = page1.body.data.map((b) => Date.parse(b.createdAt));
    assert.ok(times[0]! >= times[1]!, "newest batch first");

    const filtered = await api<ListResponse>(
      server.baseUrl,
      `/api/batches?limit=100&senderId=${otherSender.id}`,
    );
    assert.equal(filtered.body.pagination.total, 1);
    assert.equal(filtered.body.data[0]?.id, otherBatch.body.batchId);
  });
});

test("returns one batch by id and hides other users' batches", async () => {
  await withFixture(async ({ sender }) => {
    const created = await api<CreateBatchResponse>(server.baseUrl, "/api/batches", {
      method: "POST",
      body: validBatchPayload(sender.id),
    });
    assert.equal(created.status, 201);

    interface DetailResponse {
      batch: {
        id: string;
        subject: string;
        deliveryCounts: { total: number; scheduled: number };
        sender: { fromEmail: string } | null;
      };
    }

    const detail = await api<DetailResponse>(
      server.baseUrl,
      `/api/batches/${created.body.batchId}`,
    );
    assert.equal(detail.status, 200);
    assert.equal(detail.body.batch.id, created.body.batchId);
    assert.equal(detail.body.batch.deliveryCounts.total, 2);
    assert.equal(detail.body.batch.deliveryCounts.scheduled, 2);
    assert.equal(detail.body.batch.sender?.fromEmail, sender.fromEmail);

    const missing = await api<ErrorResponse>(server.baseUrl, `/api/batches/${randomUUID()}`);
    assert.equal(missing.status, 404);

    // Another user must not be able to read this batch.
    const other = await createTestUser();
    await createTestSender(other.id);
    actAs(other.id);
    try {
      const foreign = await api<ErrorResponse>(
        server.baseUrl,
        `/api/batches/${created.body.batchId}`,
      );
      assert.equal(foreign.status, 404);

      interface ListResponse {
        data: Array<{ id: string }>;
        pagination: { total: number };
      }

      const list = await api<ListResponse>(server.baseUrl, "/api/batches?limit=100");
      assert.equal(list.body.pagination.total, 0);
      assert.equal(
        list.body.data.some((b) => b.id === created.body.batchId),
        false,
      );
    } finally {
      await cleanupTestUser(other.id);
    }
  });
});
