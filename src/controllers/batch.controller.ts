import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import {
  createEmailBatch,
  findExistingBatch,
  getBatchById,
  listBatches,
  scheduleBatch,
  type BatchDetail,
  type BatchWithCounts,
  type ScheduledBatchResult,
} from "../services/batch.service.js";
import {
  idempotencyKeySchema,
  type CreateBatchBody,
  type ListBatchesQuery,
} from "../validators/batch.validator.js";
import { isUniqueConstraintError } from "../lib/db-errors.js";
import { notFound, validationError } from "../lib/errors.js";
import logger, { serializeError } from "../lib/logger.js";

/** Resolves the idempotency key from the header, the body, or a fresh UUID. */
function resolveIdempotencyKey(req: Request, body: CreateBatchBody): string {
  const header = req.get("Idempotency-Key");

  if (header !== undefined && header !== "") {
    const parsed = idempotencyKeySchema.safeParse(header);

    if (!parsed.success) {
      throw validationError([
        {
          path: "Idempotency-Key",
          message:
            parsed.error.issues[0]?.message ?? "Invalid idempotency key",
        },
      ]);
    }

    return parsed.data;
  }

  return body.idempotencyKey ?? randomUUID();
}

function scheduledRange(
  result: ScheduledBatchResult,
): { first: Date; last: Date } {
  let first = result.batch.startAt;
  let last = result.batch.startAt;

  for (const email of result.emails) {
    const time = email.scheduledAt.getTime();

    if (time < first.getTime()) first = email.scheduledAt;
    if (time > last.getTime()) last = email.scheduledAt;
  }

  return { first, last };
}

function toCreateResponse(result: ScheduledBatchResult, idempotencyKey: string) {
  const { first, last } = scheduledRange(result);

  return {
    batchId: result.batch.id,
    recipientCount: result.emails.length,
    schedulingSummary: {
      idempotencyKey,
      startAt: result.batch.startAt,
      delayMs: result.batch.delayMs,
      hourlyLimit: result.batch.hourlyLimit,
      firstScheduledAt: first,
      lastScheduledAt: last,
      outboxEventsCreated: result.emails.length,
    },
  };
}

function toBatchSummary({ batch, deliveryCounts }: BatchWithCounts) {
  return {
    id: batch.id,
    senderId: batch.senderId,
    subject: batch.subject,
    startAt: batch.startAt,
    delayMs: batch.delayMs,
    hourlyLimit: batch.hourlyLimit,
    totalEmails: batch.totalEmails,
    createdAt: batch.createdAt,
    deliveryCounts,
  };
}

function toBatchDetail(detail: BatchDetail) {
  return { ...toBatchSummary(detail), sender: detail.sender };
}

/** POST /api/batches */
export async function createBatch(req: Request, res: Response): Promise<void> {
  const body = req.validated?.body as CreateBatchBody;
  const userId = req.auth!.userId;
  const idempotencyKey = resolveIdempotencyKey(req, body);

  try {
    const result = await createEmailBatch({
      userId,
      senderId: body.senderId,
      subject: body.subject,
      body: body.body,
      startAt: body.startAt,
      delayMs: body.delayMs,
      hourlyLimit: body.hourlyLimit,
      recipients: body.recipients,
      idempotencyKey,
    });

    logger.info("Email batch scheduled", {
      userId,
      batchId: result.batch.id,
      emailCount: result.emails.length,
    });

    res.status(201).json({
      message: "Email batch scheduled successfully",
      ...toCreateResponse(result, idempotencyKey),
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      let existing: ScheduledBatchResult | null = null;

      try {
        existing = await findExistingBatch(idempotencyKey, userId);
      } catch (lookupError) {
        logger.error("Idempotency lookup failed", {
          error: serializeError(lookupError),
        });
      }

      if (existing) {
        logger.info("Returning existing email batch", {
          userId,
          batchId: existing.batch.id,
          emailCount: existing.emails.length,
        });

        res.status(200).json({
          message: "Existing batch returned",
          idempotentReplay: true,
          ...toCreateResponse(existing, idempotencyKey),
        });
        return;
      }
    }

    throw error;
  }
}

/** GET /api/batches */
export async function listBatchesHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const query = req.validated?.query as ListBatchesQuery;
  const userId = req.auth!.userId;
  const result = await listBatches(userId, query);

  res.status(200).json({
    data: result.rows.map(toBatchSummary),
    pagination: {
      page: result.page,
      limit: result.limit,
      total: result.total,
      totalPages: Math.ceil(result.total / result.limit),
    },
  });
}

/** GET /api/batches/:id */
export async function getBatchHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const { id } = req.validated?.params as { id: string };
  const userId = req.auth!.userId;

  const detail = await getBatchById(userId, id);

  if (!detail) {
    throw notFound("Batch not found");
  }

  res.status(200).json({ batch: toBatchDetail(detail) });
}

/** POST /api/batches/:id/schedule */
export async function scheduleBatchHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const { id } = req.validated?.params as { id: string };
  const userId = req.auth!.userId;

  const result = await scheduleBatch(userId, id);

  const message =
    result.eligible === 0
      ? "Batch has no eligible emails to schedule"
      : result.newlyScheduled === 0
        ? "Batch is already scheduled"
        : "Batch scheduling events ensured";

  res.status(200).json({ message, ...result });
}
