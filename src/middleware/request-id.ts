import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { runWithRequestContext } from "../lib/logger.js";

const REQUEST_ID_HEADER = "x-request-id";
const ACCEPTED_REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

function resolveRequestId(header: string | undefined): string {
  if (header && ACCEPTED_REQUEST_ID.test(header)) {
    return header;
  }

  return randomUUID();
}

/**
 * Assigns a correlation ID to every request, echoes it back in the
 * `X-Request-ID` response header, and runs the rest of the request inside a
 * correlation context so downstream logs inherit the ID automatically.
 *
 * Must be registered before Morgan and any application handler.
 */
export function requestIdMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const requestId = resolveRequestId(req.get(REQUEST_ID_HEADER));

  req.id = requestId;
  res.locals.requestId = requestId;
  res.setHeader("X-Request-ID", requestId);

  runWithRequestContext(requestId, () => {
    next();
  });
}
