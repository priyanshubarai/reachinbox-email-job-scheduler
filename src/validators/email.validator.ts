import { z } from "zod";
import {
  EMAIL_STATUSES,
  limitSchema,
  pageSchema,
} from "./common.validator.js";

export const listEmailsQuerySchema = z.object({
  page: pageSchema,
  limit: limitSchema,
  batchId: z.uuid("batchId must be a valid UUID").optional(),
  senderId: z.uuid("senderId must be a valid UUID").optional(),
  status: z.enum(EMAIL_STATUSES).optional(),
  /** Case-insensitive exact match on the recipient address. */
  recipient: z
    .email("recipient must be a valid email address")
    .transform((value) => value.trim().toLowerCase())
    .optional(),
});

export type ListEmailsQuery = z.infer<typeof listEmailsQuerySchema>;
