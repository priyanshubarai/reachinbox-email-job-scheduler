import { z } from "zod";
import {
  dateTimeSchema,
  optionalDateTime,
  pageSchema,
  limitSchema,
} from "./common.validator.js";

export const MAX_RECIPIENTS = 1000;
export const MAX_DELAY_MS = 60 * 60 * 1000;
export const MAX_HOURLY_LIMIT = 10000;
export const MAX_SUBJECT_LENGTH = 998;
export const MAX_BODY_LENGTH = 200_000;
export const MAX_RECIPIENT_NAME_LENGTH = 255;

const IDEMPOTENCY_KEY_PATTERN = /^[a-zA-Z0-9._:-]{1,200}$/;

/** Trims and lowercases an address; uniqueness/idempotency rely on this. */
const recipientEmail = z
  .email("Must be a valid email address")
  .transform((value) => value.trim().toLowerCase());

const recipientName = z
  .string()
  .trim()
  .max(MAX_RECIPIENT_NAME_LENGTH)
  .optional()
  .transform((value) => (value && value.length > 0 ? value : null));

const recipientSchema = z.union([
  z.object({
    email: recipientEmail,
    name: recipientName,
  }),
  recipientEmail.transform((email) => ({ email, name: null })),
]);

export type Recipient = z.infer<typeof recipientSchema>;

export const idempotencyKeySchema = z
  .string()
  .regex(
    IDEMPOTENCY_KEY_PATTERN,
    "Idempotency key may only contain letters, digits, '.', '_', ':' and '-' (max 200)",
  );

export const createBatchSchema = z
  .object({
    senderId: z.uuid("senderId must be a valid UUID"),
    subject: z
      .string()
      .trim()
      .min(1, "subject must not be empty")
      .max(MAX_SUBJECT_LENGTH),
    body: z
      .string()
      .trim()
      .min(1, "body must not be empty")
      .max(MAX_BODY_LENGTH),
    startAt: dateTimeSchema,
    delayMs: z
      .number()
      .int("delayMs must be an integer")
      .min(0, "delayMs must be >= 0")
      .max(MAX_DELAY_MS, `delayMs must be <= ${MAX_DELAY_MS}`),
    hourlyLimit: z
      .number()
      .int("hourlyLimit must be an integer")
      .min(1, "hourlyLimit must be >= 1")
      .max(MAX_HOURLY_LIMIT, `hourlyLimit must be <= ${MAX_HOURLY_LIMIT}`),
    recipients: z
      .array(recipientSchema)
      .min(1, "recipients must contain at least one address")
      .max(MAX_RECIPIENTS, `recipients must contain at most ${MAX_RECIPIENTS}`),
    idempotencyKey: idempotencyKeySchema.optional(),
  })
  .superRefine((value, ctx) => {
    const seen = new Set<string>();

    for (const [index, recipient] of value.recipients.entries()) {
      if (seen.has(recipient.email)) {
        ctx.addIssue({
          code: "custom",
          path: ["recipients", index, "email"],
          message: "Duplicate recipients are not allowed",
        });
      }

      seen.add(recipient.email);
    }

    // Allow a small clock skew so clients are not punished for a slow request.
    if (value.startAt.getTime() < Date.now() - 30_000) {
      ctx.addIssue({
        code: "custom",
        path: ["startAt"],
        message: "startAt cannot be in the past",
      });
    }
  });

export type CreateBatchBody = z.infer<typeof createBatchSchema>;

export const listBatchesQuerySchema = z.object({
  page: pageSchema,
  limit: limitSchema,
  senderId: z.uuid("senderId must be a valid UUID").optional(),
  createdFrom: optionalDateTime,
  createdTo: optionalDateTime,
});

export type ListBatchesQuery = z.infer<typeof listBatchesQuerySchema>;
