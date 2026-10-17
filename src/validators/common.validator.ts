import { z } from "zod";

/** Shared bounds and building blocks for request validation. */

export const DEFAULT_PAGE = 1;
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

/** Email delivery states persisted in `emails.status`. */
export const EMAIL_STATUSES = [
  "scheduled",
  "sending",
  "sent",
  "failed",
  "unknown",
] as const;

export type EmailStatus = (typeof EMAIL_STATUSES)[number];

/**
 * Parses a datetime string into a `Date`. Accepts any value `Date.parse`
 * understands (ISO-8601 with `Z` or an offset), mirroring the pre-existing
 * scheduler contract.
 */
export const dateTimeSchema = z.string().transform((value, ctx) => {
  const parsed = Date.parse(value);

  if (!Number.isFinite(parsed)) {
    ctx.addIssue({ code: "custom", message: "Must be a valid ISO-8601 datetime" });
    return z.NEVER;
  }

  return new Date(parsed);
});

export const pageSchema = z.coerce
  .number()
  .int("page must be an integer")
  .min(1, "page must be >= 1")
  .default(DEFAULT_PAGE);

export const limitSchema = z.coerce
  .number()
  .int("limit must be an integer")
  .min(1, "limit must be >= 1")
  .max(MAX_LIMIT, `limit must be <= ${MAX_LIMIT}`)
  .default(DEFAULT_LIMIT);

export const idParamSchema = z.object({
  id: z.uuid("Must be a valid UUID"),
});

/** Optional, inclusive lower bound filter. */
export const optionalDateTime = dateTimeSchema.optional();

export interface Pagination {
  page: number;
  limit: number;
  offset: number;
}

export function toPagination(page: number, limit: number): Pagination {
  return { page, limit, offset: (page - 1) * limit };
}
