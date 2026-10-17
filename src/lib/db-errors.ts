/**
 * Detects unique-constraint violations from any driver in the stack.
 *
 * Drizzle wraps driver errors, so the PostgreSQL `23505` code can sit on the
 * error itself or on one of its `cause` links.
 */
export function isUniqueConstraintError(error: unknown): boolean {
  let current: unknown = error;

  while (current instanceof Error) {
    const code = (current as { code?: unknown }).code;

    if (
      code === "23505" ||
      current.message.includes("unique constraint") ||
      current.message.includes("duplicate key")
    ) {
      return true;
    }

    current = (current as { cause?: unknown }).cause;
  }

  return false;
}
