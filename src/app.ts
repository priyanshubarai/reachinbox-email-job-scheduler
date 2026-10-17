import express from "express";
import type { ErrorRequestHandler, Request, Response } from "express";
import dotenv from "dotenv";
import helmet from "helmet";
import slowDown from "express-slow-down";
import cors from "cors";
import router from "./routes/batch.route.js";
import logger, {
  installProcessErrorHandlers,
  serializeError,
} from "./lib/logger.js";
import { requestIdMiddleware } from "./middleware/request-id.js";
import { httpLogger } from "./middleware/http-logger.js";

dotenv.config();
installProcessErrorHandlers();

const limiter = slowDown({
  windowMs: 15 * 60 * 1000, // 5 minutes
  delayAfter: 10, // allow 10 requests per `windowMs` (5 minutes) without slowing them down
  delayMs: (hits) => hits * 200, // add 200 ms of delay to every request after the 10th
  maxDelayMs: 5000, // max global delay of 5 seconds
});

const rawPort = process.env.PORT ?? "3000";
const port = Number(rawPort);

if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  logger.error("Invalid configuration: PORT must be an integer between 1 and 65535", {
    port: rawPort,
  });
  process.exit(1);
}

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
app.use("/api", router);


const errorHandler: ErrorRequestHandler = (error, req, res, next) => {
  const status =
    typeof error?.status === "number"
      ? error.status
      : typeof error?.statusCode === "number"
        ? error.statusCode
        : 500;

  const context = {
    method: req.method,
    path: (req.originalUrl || req.path).split("?")[0],
    status,
    error: serializeError(error),
  };

  if (status >= 500) {
    logger.error("Unhandled request error", context);
  } else {
    logger.warn("Request error", context);
  }

  if (res.headersSent) {
    next(error);
    return;
  }

  res
    .status(status)
    .json({ error: status >= 500 ? "Internal server error" : "Bad request" });
};

app.use(errorHandler);

const server = app.listen(port, () => {
  logger.info("HTTP server listening", {
    port,
    env: process.env.NODE_ENV ?? "development",
  });
});

server.on("error", (error: Error) => {
  logger.error("HTTP server error", { error: serializeError(error) });
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
        error: serializeError(error),
      });
      process.exit(1);
    }

    logger.info("HTTP server closed");
    process.exit(0);
  });
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
