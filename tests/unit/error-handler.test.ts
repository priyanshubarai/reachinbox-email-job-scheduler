import "../setup-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";
import { errorHandler } from "../../src/middleware/error-handler.js";
import { validationError } from "../../src/lib/errors.js";

interface Captured {
  status?: number;
  body?: unknown;
}

function run(error: unknown): Captured {
  const captured: Captured = {};

  const req = {
    method: "GET",
    path: "/api/test",
    originalUrl: "/api/test?x=1",
    id: "req-123",
  } as unknown as Request;

  const res = {
    headersSent: false,
    status(code: number) {
      captured.status = code;
      return this;
    },
    json(payload: unknown) {
      captured.body = payload;
      return this;
    },
  } as unknown as Response;

  errorHandler(error, req, res, () => {
    /* no-op */
  });

  return captured;
}

test("renders unknown errors as a generic 500 without leaking details", () => {
  const result = run(new Error("connection string postgres://secret@host/db"));

  assert.equal(result.status, 500);
  const body = result.body as { error: Record<string, unknown> };
  assert.equal(body.error.code, "INTERNAL_ERROR");
  assert.equal(body.error.message, "Internal server error");
  assert.equal(body.error.requestId, "req-123");
  assert.deepEqual(body.error.details, []);
  assert.equal(JSON.stringify(body).includes("postgres://"), false);
  assert.equal(JSON.stringify(body).includes("stack"), false);
});

test("preserves ApiError status, code and details", () => {
  const result = run(
    validationError([{ path: "body.subject", message: "subject must not be empty" }]),
  );

  assert.equal(result.status, 400);
  const body = result.body as { error: Record<string, unknown> };
  assert.equal(body.error.code, "VALIDATION_ERROR");
  assert.deepEqual(body.error.details, [
    { path: "body.subject", message: "subject must not be empty" },
  ]);
});

test("maps framework errors with a 4xx status to the shared envelope", () => {
  const result = run(Object.assign(new Error("Unexpected token"), { status: 400 }));

  assert.equal(result.status, 400);
  const body = result.body as { error: Record<string, unknown> };
  assert.equal(body.error.code, "VALIDATION_ERROR");
  assert.equal(body.error.message, "The request is invalid");
});
