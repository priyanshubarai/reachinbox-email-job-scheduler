import type { ErrorRequestHandler } from "express";
import {
  isApiError,
  type ApiErrorCode,
  type ApiErrorDetail,
} from "../lib/errors.js";
import logger, { serializeError } from "../lib/logger.js";

interface ResolvedError {
  status: number;
  code: ApiErrorCode;
  message: string;
  details: ApiErrorDetail[];
}

function codeForStatus(status: number): ApiErrorCode {
  switch (status) {
    case 400:
      return "VALIDATION_ERROR";
    case 401:
      return "UNAUTHENTICATED";
    case 403:
      return "FORBIDDEN";
    case 404:
      return "NOT_FOUND";
    case 409:
      return "CONFLICT";
    default:
      return "INTERNAL_ERROR";
  }
}

function resolveError(error: unknown): ResolvedError {
  if (isApiError(error)) {
    return {
      status: error.status,
      code: error.code,
      message: error.message,
      details: error.details,
    };
  }

  const status =
    typeof (error as { status?: unknown })?.status === "number"
      ? (error as { status: number }).status
      : typeof (error as { statusCode?: unknown })?.statusCode === "number"
        ? (error as { statusCode: number }).statusCode
        : 500;

  if (status >= 500) {
    return {
      status: 500,
      code: "INTERNAL_ERROR",
      message: "Internal server error",
      details: [],
    };
  }

  const safeStatus = status >= 400 ? status : 500;

  return {
    status: safeStatus,
    code: codeForStatus(safeStatus),
    message:
      safeStatus === 400
        ? "The request is invalid"
        : "The request could not be completed",
    details: [],
  };
}

/**
 * The single boundary where request errors are logged and rendered. Client
 * responses never include a stack trace or database/internal detail.
 */
export const errorHandler: ErrorRequestHandler = (error, req, res, next) => {
  const resolved = resolveError(error);

  if (res.headersSent) {
    next(error);
    return;
  }

  const context = {
    method: req.method,
    path: (req.originalUrl || req.path).split("?")[0],
    status: resolved.status,
    error: serializeError(error),
  };

  if (resolved.status >= 500) {
    logger.error("Unhandled request error", context);
  } else {
    logger.warn("Request error", context);
  }

  res.status(resolved.status).json({
    error: {
      code: resolved.code,
      message: resolved.message,
      details: resolved.details,
      requestId: req.id,
    },
  });
};
