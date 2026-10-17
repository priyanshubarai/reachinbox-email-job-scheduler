import { pathToFileURL } from "node:url";
import express from "express";
import type { Request, Response } from "express";
import dotenv from "dotenv";
import helmet from "helmet";
import slowDown from "express-slow-down";
import cors from "cors";
import apiRouter from "./routes/index.js";
import logger, { installProcessErrorHandlers } from "./lib/logger.js";
import { requestIdMiddleware } from "./middleware/request-id.js";
import { httpLogger } from "./middleware/http-logger.js";
import { requireAuth } from "./middleware/auth.js";
import { errorHandler } from "./middleware/error-handler.js";
import { notFoundHandler } from "./middleware/not-found.js";

dotenv.config();

/**
 * Builds the Express application without binding a port, so tests can import it
 * and listen on an ephemeral port. Middleware order is preserved:
 * request id -> HTTP log -> security -> parsers -> health -> /api
 * (slow-down -> auth -> routes) -> 404 -> error handler.
 */
export function createApp(): express.Express {
  const limiter = slowDown({
    windowMs: 15 * 60 * 1000, // 15 minutes
    delayAfter: 10, // allow 10 requests per `windowMs` without slowing them down
    delayMs: (hits) => hits * 200, // add 200 ms of delay to every request after the 10th
    maxDelayMs: 5000, // max global delay of 5 seconds
  });

  const app = express();

  app.use(requestIdMiddleware);
  app.use(httpLogger);

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          "font-src": ["'self'", "external-website.com"],
          "style-src": null,
        },
      },
      referrerPolicy: { policy: "no-referrer" },
      hsts: {
        maxAge: 86400,
        includeSubDomains: false,
      },
      noSniff: false,
      frameguard: { action: "deny" },
    }),
  );

  const corsOptions = {
    // origin: 'http://example.com',
    // optionsSuccessStatus: 200 // some legacy browsers (IE11, various SmartTVs) choke on 204
  };
  app.use(cors(corsOptions));
  app.use(express.json());

  app.get("/health", (_req: Request, res: Response) => {
    res.status(200).json({ status: "ok" });
  });

  app.use("/api", limiter);
  app.use("/api", requireAuth);
  app.use("/api", apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

function isMainModule(): boolean {
  const entry = process.argv[1];

  if (!entry) {
    return false;
  }

  return pathToFileURL(entry).href === import.meta.url;
}

function startServer(): void {
  installProcessErrorHandlers();

  const rawPort = process.env.PORT ?? "3000";
  const port = Number(rawPort);

  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    logger.error(
      "Invalid configuration: PORT must be an integer between 1 and 65535",
      { port: rawPort },
    );
    process.exit(1);
  }

  const app = createApp();

  const server = app.listen(port, () => {
    logger.info("HTTP server listening", {
      port,
      env: process.env.NODE_ENV ?? "development",
    });
  });

  server.on("error", (error: Error) => {
    logger.error("HTTP server error", { error: error.message });
  });

  function shutdown(signal: string): void {
    logger.info("HTTP server shutting down", { signal });

    const forceExit = setTimeout(() => {
      logger.error("Forced shutdown after timeout", { timeoutMs: 10_000 });
      process.exit(1);
    }, 10_000);
    forceExit.unref();

    server.close((error) => {
      if (error) {
        logger.error("Error while closing HTTP server", {
          error: error.message,
        });
        process.exit(1);
      }

      logger.info("HTTP server closed");
      process.exit(0);
    });
  }

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

if (isMainModule()) {
  startServer();
}
