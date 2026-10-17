import "../setup-env.js";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { closeDb } from "../../src/db/index.js";
import { cleanupTestUser, createTestUser } from "../helpers/db.js";
import {
  actAs,
  actAsNobody,
  api,
  startTestServer,
  type TestServer,
} from "../helpers/server.js";

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
  actAsNobody();
  await server.close();
  await closeDb();
});

function assertEnvelope(body: ErrorResponse, code: string): void {
  assert.equal(body.error.code, code);
  assert.equal(typeof body.error.message, "string");
  assert.ok(Array.isArray(body.error.details));
  assert.equal(typeof body.error.requestId, "string");
  assert.ok(body.error.requestId.length > 0);
}

test("rejects every protected endpoint without an identity", async () => {
  actAsNobody();

  const requests: Array<{ method: string; path: string; body?: unknown }> = [
    { method: "GET", path: "/api/batches" },
    { method: "GET", path: `/api/batches/${randomUUID()}` },
    { method: "POST", path: `/api/batches/${randomUUID()}/schedule` },
    { method: "GET", path: "/api/emails" },
    { method: "GET", path: `/api/emails/${randomUUID()}` },
    { method: "GET", path: "/api/dashboard/stats" },
    { method: "POST", path: "/api/batches", body: {} },
  ];

  for (const request of requests) {
    const res = await api<ErrorResponse>(server.baseUrl, request.path, {
      method: request.method,
      body: request.body,
    });
    assert.equal(res.status, 401, `${request.method} ${request.path}`);
    assertEnvelope(res.body, "UNAUTHENTICATED");
  }
});

test("rejects a configured development identity that does not exist", async () => {
  actAs(2_000_000_000);

  const res = await api<ErrorResponse>(server.baseUrl, "/api/batches");
  assert.equal(res.status, 401);
  assertEnvelope(res.body, "UNAUTHENTICATED");

  actAsNobody();
});

test("returns a consistent 404 envelope for unknown routes", async () => {
  const user = await createTestUser();
  actAs(user.id);

  try {
    const res = await api<ErrorResponse>(server.baseUrl, "/api/does-not-exist");
    assert.equal(res.status, 404);
    assertEnvelope(res.body, "NOT_FOUND");
    assert.equal(res.body.error.message, "Route not found");
  } finally {
    actAsNobody();
    await cleanupTestUser(user.id);
  }
});

test("returns a 400 envelope with field details for an invalid id param", async () => {
  const user = await createTestUser();
  actAs(user.id);

  try {
    const res = await api<ErrorResponse>(server.baseUrl, "/api/batches/not-a-uuid");
    assert.equal(res.status, 400);
    assertEnvelope(res.body, "VALIDATION_ERROR");
    assert.ok(res.body.error.details.some((detail) => detail.path === "params.id"));
  } finally {
    actAsNobody();
    await cleanupTestUser(user.id);
  }
});

test("returns a 400 envelope for a malformed JSON body", async () => {
  const user = await createTestUser();
  actAs(user.id);

  try {
    const response = await fetch(`${server.baseUrl}/api/batches`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ this is not json",
    });

    assert.equal(response.status, 400);
    const body = (await response.json()) as ErrorResponse;
    assertEnvelope(body, "VALIDATION_ERROR");
    // The raw parser error must not leak to the client.
    assert.equal(JSON.stringify(body).includes("this is not json"), false);
  } finally {
    actAsNobody();
    await cleanupTestUser(user.id);
  }
});
