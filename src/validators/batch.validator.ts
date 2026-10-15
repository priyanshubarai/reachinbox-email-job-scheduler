const MAX_RECIPIENTS = 1000;
const MAX_DELAY_MS = 60 * 60 * 1000;
const MAX_HOURLY_LIMIT = 10000;

const IDEMPOTENCY_KEY_PATTERN = /^[a-zA-Z0-9._:-]{1,200}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface CreateBatchInput {
  userId: number;
  subject: string;
  body: string;
  startAt: Date;
  delayMs: number;
  hourlyLimit: number;
  recipients: string[];
  idempotencyKey: string;
}

export type ValidationResult =
  | { ok: true; data: CreateBatchInput }
  | { ok: false; error: string };


export function validateCreateBatchRequest(body: unknown): ValidationResult {
  const {
    userId,
    subject,
    body: emailBody,
    startAt,
    delayMs,
    hourlyLimit,
    recipients,
    idempotencyKey,
  } = (body ?? {}) as Record<string, unknown>;

  if (
    typeof userId !== "number" ||
    !Number.isInteger(userId) ||
    userId <= 0 ||
    typeof subject !== "string" ||
    !subject.trim() ||
    subject.length > 998 ||
    typeof emailBody !== "string" ||
    !emailBody.trim() ||
    typeof startAt !== "string" ||
    !Number.isFinite(Date.parse(startAt)) ||
    typeof delayMs !== "number" ||
    !Number.isInteger(delayMs) ||
    delayMs < 0 ||
    delayMs > MAX_DELAY_MS ||
    typeof hourlyLimit !== "number" ||
    !Number.isInteger(hourlyLimit) ||
    hourlyLimit < 1 ||
    hourlyLimit > MAX_HOURLY_LIMIT ||
    !Array.isArray(recipients) ||
    recipients.length === 0 ||
    recipients.length > MAX_RECIPIENTS ||
    typeof idempotencyKey !== "string" ||
    !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)
  ) {
    return { ok: false, error: "Invalid scheduling request" };
  }

  const normalizedRecipients: string[] = [];

  for (const recipient of recipients) {
    if (
      typeof recipient !== "string" ||
      recipient.length > 320 ||
      !EMAIL_PATTERN.test(recipient.trim())
    ) {
      return { ok: false, error: "One or more recipient addresses are invalid" };
    }

    normalizedRecipients.push(recipient.trim().toLowerCase());
  }

  // Reject duplicates.
  if (new Set(normalizedRecipients).size !== normalizedRecipients.length) {
    return { ok: false, error: "Duplicate recipients are not allowed" };
  }

  const start = new Date(startAt);

  if (start.getTime() < Date.now() - 30_000) {
    return { ok: false, error: "Start time cannot be in the past" };
  }

  return {
    ok: true,
    data: {
      userId,
      subject,
      body: emailBody,
      startAt: start,
      delayMs,
      hourlyLimit,
      recipients: normalizedRecipients,
      idempotencyKey,
    },
  };
}
