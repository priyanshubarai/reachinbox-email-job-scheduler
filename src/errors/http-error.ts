/**
 * Error carrying an HTTP status code so controllers can translate
 * service failures into responses without inspecting error messages.
 */
export class HttpError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
  }
}

/**
 * Detects a Postgres unique-constraint violation. When raised for an
 * idempotency key it usually signals a replayed request rather than a
 * genuine failure, so callers can return the original resource.
 */
export function isUniqueConstraintError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.message.includes("unique constraint") ||
    error.message.includes("duplicate key")
  );
}
