import type { Request, Response } from "express";
import { getEmailById, listEmails } from "../services/email.service.js";
import type { ListEmailsQuery } from "../validators/email.validator.js";
import { notFound } from "../lib/errors.js";

/** GET /api/emails */
export async function listEmailsHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const query = req.validated?.query as ListEmailsQuery;
  const userId = req.auth!.userId;
  const result = await listEmails(userId, query);

  res.status(200).json({
    data: result.rows,
    pagination: {
      page: result.page,
      limit: result.limit,
      total: result.total,
      totalPages: Math.ceil(result.total / result.limit),
    },
  });
}

/** GET /api/emails/:id */
export async function getEmailHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const { id } = req.validated?.params as { id: string };
  const userId = req.auth!.userId;

  const email = await getEmailById(userId, id);

  if (!email) {
    throw notFound("Email not found");
  }

  res.status(200).json({ email });
}
