import type { RequestHandler } from "express";

/**
 * Terminal handler for unmatched routes. Registered after all route handlers so
 * unknown paths return the same error envelope as everything else.
 */
export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({
    error: {
      code: "NOT_FOUND",
      message: "Route not found",
      details: [],
      requestId: req.id,
    },
  });
};
