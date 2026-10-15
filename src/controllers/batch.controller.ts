import type { Request, Response } from "express";
import { createEmailBatch, findExistingBatch } from "../services/batch.service.js";
import { validateCreateBatchRequest } from "../validators/batch.validator.js";

function isUniqueConstraintError(error: unknown): boolean {
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

/** POST /batches — validate the request, delegate to the service, shape the response. */
export async function createBatch(req: Request, res: Response) {
  console.log("Recieved request at /api/batches");
  const validation = validateCreateBatchRequest(req.body);

  if (!validation.ok) {
    return res.status(400).json({ error: validation.error });
  }

  const input = validation.data;

  try {
    const result = await createEmailBatch(input);

    if (!result) {
      return res.status(404).json({ error: "User not found" });
    }

    return res.status(201).json({
      message: "Email batch scheduled successfully",
      batch: result.batch,
      emails: result.emails,
    });
  } catch (error) {
  
    // Return the original batch.
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
