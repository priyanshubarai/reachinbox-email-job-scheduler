import "../setup-env.js";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { closeDb } from "../../src/db/index.js";
import {
  cleanupTestUser,
  countOutboxEventsForBatch,
  createTestSender,
  createTestUser,
  deleteOutboxEventsForBatch,
  getEmailsForBatch,
  insertTestBatch,
  setBatchEmailStatus,
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
  batchId: string;
  recipientCount: number;
}

interface ScheduleResponse {
  message: string;
  batchId: string;
  totalEmails: number;
  eligible: number;
  alreadyScheduled: number;
  newlyScheduled: number;
  ineligible: number;
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

async function createBatch(senderId: string): Promise<string> {
  const res = await api<CreateBatchResponse>(server.baseUrl, "/api/batches", {
    method: "POST",
    body: validBatchPayload(senderId),
  });
  assert.equal(res.status, 201);
  return res.body.batchId;
}

test("scheduling an armed batch changes nothing", async () => {
  await withFixture(async ({ sender }) => {
    const batchId = await createBatch(sender.id);
    const before = await countOutboxEventsForBatch(batchId);

    const first = await api<ScheduleResponse>(
      server.baseUrl,
      `/api/batches/${batchId}/schedule`,
      { method: "POST" },
    );
    assert.equal(first.status, 200);
    assert.equal(first.body.alreadyScheduled, 2);
    assert.equal(first.body.newlyScheduled, 0);
    assert.equal(first.body.eligible, 2);

    const second = await api<ScheduleResponse>(
      server.baseUrl,
      `/api/batches/${batchId}/schedule`,
      { method: "POST" },
    );
    assert.equal(second.status, 200);
    assert.equal(second.body.newlyScheduled, 0);

    assert.equal(await countOutboxEventsForBatch(batchId), before);
  });
});

test("scheduling repairs outbox events that were lost", async () => {
  await withFixture(async ({ sender }) => {
    const batchId = await createBatch(sender.id);
    const deleted = await deleteOutboxEventsForBatch(batchId);
    assert.equal(deleted, 2);
    assert.equal(await countOutboxEventsForBatch(batchId), 0);

    const repaired = await api<ScheduleResponse>(
      server.baseUrl,
      `/api/batches/${batchId}/schedule`,
      { method: "POST" },
    );
    assert.equal(repaired.status, 200);
    assert.equal(repaired.body.newlyScheduled, 2);
    assert.equal(repaired.body.alreadyScheduled, 0);
    assert.equal(await countOutboxEventsForBatch(batchId), 2);

    // Repeated calls must not duplicate events or jobs.
    const repeat = await api<ScheduleResponse>(
      server.baseUrl,
      `/api/batches/${batchId}/schedule`,
      { method: "POST" },
    );
    assert.equal(repeat.body.newlyScheduled, 0);
    assert.equal(await countOutboxEventsForBatch(batchId), 2);
  });
});

test("reports when a batch has no eligible emails", async () => {
  await withFixture(async ({ sender }) => {
    const batchId = await createBatch(sender.id);
    await deleteOutboxEventsForBatch(batchId);
    await setBatchEmailStatus(batchId, "sent");

    const res = await api<ScheduleResponse>(
      server.baseUrl,
      `/api/batches/${batchId}/schedule`,
      { method: "POST" },
    );

    assert.equal(res.status, 200);
    assert.equal(res.body.eligible, 0);
    assert.equal(res.body.newlyScheduled, 0);
    assert.match(res.body.message, /no eligible/i);
  });
});

test("scheduling a missing or foreign batch returns 404", async () => {
  await withFixture(async () => {
    const missing = await api<ErrorResponse>(
      server.baseUrl,
      `/api/batches/${randomUUID()}/schedule`,
      { method: "POST" },
    );
    assert.equal(missing.status, 404);

    const other = await createTestUser();
    const otherSender = await createTestSender(other.id);
    const foreignBatch = await insertTestBatch({
      userId: other.id,
      senderId: otherSender.id,
    });

    try {
      const foreign = await api<ErrorResponse>(
        server.baseUrl,
        `/api/batches/${foreignBatch.id}/schedule`,
        { method: "POST" },
      );
      assert.equal(foreign.status, 404);
      assert.equal(foreign.body.error.code, "NOT_FOUND");
    } finally {
      await cleanupTestUser(other.id);
    }
  });
});

test("scheduling never publishes a queue job directly", async () => {
  await withFixture(async ({ sender }) => {
    const batchId = await createBatch(sender.id);
    await deleteOutboxEventsForBatch(batchId);

    await api<ScheduleResponse>(server.baseUrl, `/api/batches/${batchId}/schedule`, {
      method: "POST",
    });

    // The events exist for the dispatcher to drain.
    const emails = await getEmailsForBatch(batchId);
    assert.equal(emails.length, 2);
    assert.equal(await countOutboxEventsForBatch(batchId), 2);

    // No job was published for these emails by the API. (Queue-level keys left
    // by other suites are ignored; a leaked job would contain the email id.)
    const leakedJobs = await findQueueJobsForEmails(emails.map((email) => email.id));
    assert.deepEqual(leakedJobs ?? [], []);
  });
});
