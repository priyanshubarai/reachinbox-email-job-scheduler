import { eq } from "drizzle-orm";
import type { RequestHandler } from "express";
import db from "../db/index.js";
import { usersTable } from "../db/schema.js";
import { unauthenticated } from "../lib/errors.js";
import logger from "../lib/logger.js";

const DEV_USER_ID_ENV = "AUTH_DEV_USER_ID";

/**
 * Development/test identity.
 *
 * This is NOT authentication. When there is no authentication layer wired up
 * yet, the server can impersonate a single fixed user for local development and
 * automated tests. It is never enabled in production and no request value
 * (header, cookie or body) can influence it — only the explicitly configured
 * `AUTH_DEV_USER_ID` environment variable.
 */
function configuredDevUserId(): number | null {
  if (process.env.NODE_ENV === "production") {
    return null;
  }

  const raw = process.env[DEV_USER_ID_ENV]?.trim();

  if (!raw) {
    return null;
  }

  const id = Number(raw);

  return Number.isInteger(id) && id > 0 ? id : null;
}

// Verified development users, so we do not hit the database on every request
// while still supporting tests that switch identity between requests.
const verifiedDevUsers = new Set<number>();

let devAuthWarned = false;

async function devUserExists(userId: number): Promise<boolean> {
  if (verifiedDevUsers.has(userId)) {
    return true;
  }

  const rows = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);

  if (rows.length === 1) {
    verifiedDevUsers.add(userId);
    return true;
  }

  return false;
}

/**
 * Authentication integration point.
 *
 * A real authentication layer (for example Google OAuth token verification)
 * must populate `req.auth` before this middleware runs, or be composed ahead of
 * it. Until that exists, requests are either served as the explicitly
 * configured development user or rejected with 401 — never as a client-supplied
 * identity.
 */
export const requireAuth: RequestHandler = async (req, _res, next) => {
  try {
    if (req.auth?.userId) {
      next();
      return;
    }

    const devUserId = configuredDevUserId();

    if (devUserId === null) {
      next(
        unauthenticated(
          "Authentication is not configured on this server; the API must not be exposed publicly",
        ),
      );
      return;
    }

    if (!(await devUserExists(devUserId))) {
      next(
        unauthenticated(
          `Configured development user (${DEV_USER_ID_ENV}) does not exist`,
        ),
      );
      return;
    }

    if (!devAuthWarned) {
      devAuthWarned = true;
      logger.warn(
        "Development identity is active; this is not real authentication",
        { envVar: DEV_USER_ID_ENV, userId: devUserId },
      );
    }

    req.auth = { userId: devUserId };
    next();
  } catch (error) {
    next(error);
  }
};
