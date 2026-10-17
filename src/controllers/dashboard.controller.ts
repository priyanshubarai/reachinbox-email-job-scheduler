import type { Request, Response } from "express";
import { getDashboardStats } from "../services/dashboard.service.js";

/** GET /api/dashboard/stats */
export async function getDashboardStatsHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const userId = req.auth!.userId;
  const stats = await getDashboardStats(userId);

  res.status(200).json(stats);
}
