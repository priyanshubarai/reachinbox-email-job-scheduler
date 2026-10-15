import type { Request, Response } from "express";
import { HttpError, isUniqueConstraintError } from "../errors/http-error.js";
import { createEmailBatch, findExistingBatch } from "../services/batch.service.js";
import { validateCreateBatchRequest } from "../validators/batch.validator.js";

/** POST /batches — validate the request, delegate to the service, shape the response. */
export async function createBatch(req: Request, res: Response) {
  const validation = validateCreateBatchRequest(req.body);

  if (!validation.ok) {
    return res.status(400).json({ error: validation.error });
  }

  const input = validation.data;

  try {
    const result = await createEmailBatch(input);

    return res.status(201).json({
      message: "Email batch scheduled successfully",
      batch: result.batch,
      emails: result.emails,
    });
  } catch (error) {
    if (error instanceof HttpError && error.statusCode === 404) {
      return res.status(404).json({ error: error.message });
    }

    // A unique-key conflict can indicate a replayed request.
    // Return the original batch instead of creating duplicates.
    if (isUniqueConstraintError(error)) {
      try {
        const existing = await findExistingBatch(input.idempotencyKey);

        if (existing) {
          return res.status(200).json({
            message: "Existing batch returned",
            batch: existing.batch,
            emails: existing.emails,
          });
        }
      } catch (lookupError) {
        console.error("Idempotency lookup failed:", lookupError);
      }
    }

    console.error("Scheduling request failed:", error);

    return res.status(500).json({
      error: "Unable to schedule email batch",
    });
  }
}
