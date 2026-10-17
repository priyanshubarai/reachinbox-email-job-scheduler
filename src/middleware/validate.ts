import type { RequestHandler } from "express";
import type { ZodType } from "zod";
import { validationError, type ApiErrorDetail } from "../lib/errors.js";

interface RequestSchemas {
  body?: ZodType;
  query?: ZodType;
  params?: ZodType;
}

function formatPath(path: readonly PropertyKey[]): string {
  if (path.length === 0) {
    return "(request)";
  }

  return path
    .map((segment) =>
      typeof segment === "number" ? `[${segment}]` : String(segment),
    )
    .join(".");
}

/**
 * Parses and replaces `req.body` / `req.query` / `req.params` with the
 * normalized values and stores them on `req.validated` for handlers. Any
 * failure short-circuits with a 400 and one detail per invalid field.
 */
export function validate(schemas: RequestSchemas): RequestHandler {
  return (req, _res, next) => {
    const details: ApiErrorDetail[] = [];
    const parsed: Record<string, unknown> = {};

    for (const key of ["body", "query", "params"] as const) {
      const schema = schemas[key];

      if (!schema) {
        continue;
      }

      const result = schema.safeParse(req[key]);

      if (!result.success) {
        for (const issue of result.error.issues) {
          details.push({
            path: `${key}.${formatPath(issue.path)}`,
            message: issue.message,
            ...(issue.code ? { code: issue.code } : {}),
          });
        }
        continue;
      }

      parsed[key] = result.data;
    }

    if (details.length > 0) {
      next(validationError(details));
      return;
    }

    req.validated = { ...req.validated, ...parsed };
    next();
  };
}
