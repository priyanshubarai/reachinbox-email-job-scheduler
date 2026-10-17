/**
 * Adds the correlation ID assigned by the request-id middleware to Express's
 * Request type so handlers and downstream logs can read `req.id` safely.
 */
declare global {
  namespace Express {
    interface Request {
      id: string;
    }
  }
}

export {};
