/**
 * Produces a bounded, secret-free string for client-facing error fields.
 *
 * Stored delivery errors originate from SMTP/network layers. They are safe by
 * default but may occasionally echo an envelope or credential-looking token, so
 * the text is truncated and obvious secret patterns are redacted before it is
 * returned by the API.
 */

const MAX_ERROR_LENGTH = 300;

const SECRET_PATTERNS: RegExp[] = [
  /(password|passwd|pwd)\s*[=:]\s*\S+/gi,
  /(authorization|auth)\s*[=:]\s*\S+/gi,
  /\bbearer\s+\S+/gi,
  /(api[_-]?key|apikey)\s*[=:]\s*\S+/gi,
  /(access[_-]?token|refresh[_-]?token|secret)\s*[=:]\s*\S+/gi,
];

export function sanitizeErrorText(
  raw: string | null | undefined,
): string | null {
  if (typeof raw !== "string") {
    return null;
  }

  let text = raw;

  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, "[redacted]");
  }

  text = text.replace(/\s+/g, " ").trim();

  if (!text) {
    return null;
  }

  if (text.length > MAX_ERROR_LENGTH) {
    text = `${text.slice(0, MAX_ERROR_LENGTH - 1)}\u2026`;
  }

  return text;
}
