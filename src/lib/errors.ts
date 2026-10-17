/**
 * Typed application errors. Handlers throw these; a single error middleware
 * turns them into the public error envelope. SQL/stack details never reach the
 * client.
 */

export type ApiErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "INTERNAL_ERROR";

export interface ApiErrorDetail {
  path: string;
  message: string;
  code?: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly details: ApiErrorDetail[];

  constructor(
    status: number,
    code: ApiErrorCode,
    message: string,
    details: ApiErrorDetail[] = [],
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function validationError(
  details: ApiErrorDetail[],
  message = "The request is invalid",
): ApiError {
  return new ApiError(400, "VALIDATION_ERROR", message, details);
}

export function unauthenticated(
  message = "Authentication is required",
): ApiError {
  return new ApiError(401, "UNAUTHENTICATED", message);
}

export function forbidden(message = "You do not have access to this resource"): ApiError {
  return new ApiError(403, "FORBIDDEN", message);
}

export function notFound(message = "The requested resource was not found"): ApiError {
  return new ApiError(404, "NOT_FOUND", message);
}

export function conflict(message = "The request conflicts with the current state"): ApiError {
  return new ApiError(409, "CONFLICT", message);
}

export function internalError(message = "An unexpected error occurred"): ApiError {
  return new ApiError(500, "INTERNAL_ERROR", message);
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}
