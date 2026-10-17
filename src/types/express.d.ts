/**
 * Request-scoped values attached by middleware.
 *
 * `auth` is only ever populated by an authentication layer. The API never
 * derives the current user from a client-supplied id or an arbitrary header.
 */
declare global {
  namespace Express {
    interface Request {
      id: string;
      auth?: { userId: number };
      /** Values parsed and normalized by the `validate` middleware. */
      validated?: {
        body?: unknown;
        query?: unknown;
        params?: unknown;
      };
    }
  }
}

export {};
