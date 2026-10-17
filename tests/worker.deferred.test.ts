import "./setup-env.js";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import redisConnection from "../src/utils/email.redis.js";
import { reserveSendCapacity } from "../src/utils/rate-limiter.js";

import { cleanupRlKeys } from "./helpers/redis.js";
import { createFixture, getEmail, removeFixture, type Fixture } from "./helpers/fixtures.js";
import { assertQueueIsEmpty, enqueueSendJob, emailQueue, closeQueue, countJobsForEmail } from "./helpers/queue.js";

const here = dirname(fileURLToPath(import.meta.url));
const workerChildPath = resolve(here, "worker-child.ts");

function newUserId(): number {
  return 10_000_000 + Math.floor(Math.random() * 1_000_000);
}

async function waitForEmailStatus(emailId: string, target: string, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await getEmail(emailId);
    if (row?.status === target) return row;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for email ${emailId} status=${target}; last=${row?.status}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

function spawnWorkerChild(label: string): Promise<ChildProcess> {
  const proc = spawn(
    process.execPath,
    ["--import", "tsx", "--experimental-test-module-mocks", workerChildPath],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    },
  );
  proc.stdout.on("data", (d) => {
    // pipe to stderr for visibility
    console.error(`[worker-${label}]`, d.toString());
  });
  proc.stderr.on("data", (d) => {
    console.error(`[worker-${label}-err]`, d.toString());
  });
  return Promise.resolve(proc);
}

async function waitForWorkerReady(proc: ChildProcess, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let buf = "";
  return new Promise((resolve, reject) => {
    const onData = (d: Buffer) => {
      buf += d.toString();
      if (buf.includes("worker-ready")) {
        proc.stdout.off("data", onData);
        resolve();
      }
    };
    proc.stdout.on("data", onData);
    setTimeout(() => {
      proc.stdout.off("data", onData);
      reject(new Error(`worker never became ready: ${buf}`));
    }, deadline - Date.now());
  });
}

async function shutdownChild(proc: ChildProcess, timeoutMs = 10000): Promise<void> {
  if (proc.killed) return;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (!proc.killed) proc.kill("SIGKILL");
      resolve();
    }, timeoutMs);
    proc.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    proc.send?.("shutdown");
    proc.kill("SIGTERM");
  });
}

after(async () => {
  await closeQueue();
  await redisConnection.quit();
});

test("F: real worker defers on rate-limit; completes after capacity freed", async () => {
  await assertQueueIsEmpty();

  const userId = newUserId();
  await cleanupRlKeys(redisConnection, userId);

  const fixture: Fixture = await createFixture({
    tenantHourlyLimit: 1000,
    senderHourlyLimit: 1,
  });

  // Exhaust the single slot so the next reservation is denied.
  await reserveSendCapacity({
    emailId: `filler-${fixture.userId}`,
    userId: fixture.userId,
    senderId: fixture.senderId,
    senderHourlyLimit: 1,
    tenantHourlyLimit: 1000,
    minIntervalMs: 0,
  });

  await enqueueSendJob(fixture.emailId, { delay: 0 });

  // Spawn a real worker to process the job; it should defer.
  const child = await spawnWorkerChild("f1");
  await waitForWorkerReady(child);

  // Wait for job to become delayed and email to remain scheduled.
  const deadline = Date.now() + 20000;
  let jobDelayed = false;
  while (Date.now() < deadline) {
    const job = await emailQueue.getJob(fixture.emailId);
    if (job && (await job.getState()) === "delayed") {
      jobDelayed = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(jobDelayed, true);

  const emailAfterDefer = await getEmail(fixture.emailId);
  assert.equal(emailAfterDefer?.status, "scheduled");
  assert.equal(await countJobsForEmail(fixture.emailId), 1);

  // Free capacity and promote.
  await cleanupRlKeys(redisConnection, fixture.userId);
  const delayedJob = await emailQueue.getJob(fixture.emailId);
  if (!delayedJob) throw new Error("job disappeared while delayed");
  await delayedJob.promote();

  // Wait for email to be sent.
  const sentEmail = await waitForEmailStatus(fixture.emailId, "sent");
  assert.equal(sentEmail.status, "sent");
  assert.ok(sentEmail.providerMessageId?.startsWith("mock-"));

  await shutdownChild(child);
  await removeFixture(fixture);
  await cleanupRlKeys(redisConnection, fixture.userId);
});

test("G: delayed job survives worker restart and completes", async () => {
  await assertQueueIsEmpty();

  const userId = newUserId();
  await cleanupRlKeys(redisConnection, userId);

  const fixture: Fixture = await createFixture({
    tenantHourlyLimit: 1000,
    senderHourlyLimit: 1,
  });

  await reserveSendCapacity({
    emailId: `filler-${fixture.userId}`,
    userId: fixture.userId,
    senderId: fixture.senderId,
    senderHourlyLimit: 1,
    tenantHourlyLimit: 1000,
    minIntervalMs: 0,
  });

  await enqueueSendJob(fixture.emailId, { delay: 0 });

  // First worker instance: defers.
  let child = await spawnWorkerChild("g1");
  await waitForWorkerReady(child);

  const deadline = Date.now() + 20000;
  let delayed = false;
  while (Date.now() < deadline) {
    const job = await emailQueue.getJob(fixture.emailId);
    if (job && (await job.getState()) === "delayed") {
      delayed = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(delayed, true);
  assert.equal((await getEmail(fixture.emailId))?.status, "scheduled");

  // Shutdown first worker.
  await shutdownChild(child);

  // Job still delayed and persisted.
  const jobAfterShutdown = await emailQueue.getJob(fixture.emailId);
  if (!jobAfterShutdown) throw new Error("job lost after shutdown");
  assert.equal(await jobAfterShutdown.getState(), "delayed");
  assert.equal((await getEmail(fixture.emailId))?.status, "scheduled");

  // Free capacity and promote before starting second worker.
  await cleanupRlKeys(redisConnection, fixture.userId);
  await jobAfterShutdown.promote();

  // Second worker: processes promoted job.
  child = await spawnWorkerChild("g2");
  await waitForWorkerReady(child);

  const sent = await waitForEmailStatus(fixture.emailId, "sent", 25000);
  assert.equal(sent.status, "sent");
  assert.ok(sent.providerMessageId?.startsWith("mock-"));

  await shutdownChild(child);
  await removeFixture(fixture);
  await cleanupRlKeys(redisConnection, fixture.userId);
});
