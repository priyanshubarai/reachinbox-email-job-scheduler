import "dotenv/config";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  addColors,
  createLogger,
  format,
  transports,
  type Logger,
} from "winston";


export const LOG_LEVELS = {
  error: 0,
  warn: 1,
  http: 2,
  info: 3,
  debug: 4,
} as const;

export type LogLevel = keyof typeof LOG_LEVELS;

const LEVEL_COLORS = {
  error: "red",
  warn: "yellow",
  info: "green",
  http: "magenta",
  debug: "gray",
} as const;

const isProduction = process.env.NODE_ENV === "production";

function resolveLevel(): LogLevel {
  const configured = process.env.LOG_LEVEL?.trim().toLowerCase();

  if (configured && configured in LOG_LEVELS) {
    return configured as LogLevel;
  }

  return isProduction ? "info" : "debug";
}

export interface RequestContext {
  requestId: string;
}

const requestContext = new AsyncLocalStorage<RequestContext>();

export function getRequestId(): string | undefined {
  try {
    return requestContext.getStore()?.requestId;
  } catch {
    return undefined;
  }
}


// every log emitted downstream is automatically correlated with `requestId`
export function runWithRequestContext<T>(requestId: string, callback: () => T): T {
  return requestContext.run({ requestId }, callback);
}

export interface SerializedError {
  name: string;
  message: string;
  code?: string | number;
  stack?: string;
}

export function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    const serialized: SerializedError = {
      name: error.name,
      message: error.message,
    };

    const code = (error as { code?: unknown }).code;

    if (typeof code === "string" || typeof code === "number") {
      serialized.code = code;
    }

    if (error.stack) {
      serialized.stack = error.stack;
    }

    return serialized;
  }

  return { name: "Error", message: String(error) };
}

const correlationFormat = format((info) => {
  const requestId = getRequestId();

  if (requestId && !info.requestId) {
    info.requestId = requestId;
  }

  return info;
});

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

const useColor = !isProduction && Boolean(process.stdout.isTTY);

const devFormat = format.combine(
  format.timestamp({ format: "YYYY-MM-DD HH:mm:ss.SSS" }),
  correlationFormat(),
  ...(useColor ? [format.colorize({ all: true })] : []),
  format.printf((info) => {
    const { level, message, timestamp, requestId, ...meta } = info;

    const correlation =
      typeof requestId === "string" ? ` [${requestId}]` : "";
    const details = Object.keys(meta).length > 0 ? ` ${safeStringify(meta)}` : "";

    return `${String(timestamp)} ${level}${correlation} ${String(message)}${details}`;
  }),
);

const productionFormat = format.combine(
  format.timestamp(),
  correlationFormat(),
  format.json(),
);

addColors({ ...LEVEL_COLORS });

export const logger: Logger = createLogger({
  levels: LOG_LEVELS,
  level: resolveLevel(),
  format: isProduction ? productionFormat : devFormat,
  defaultMeta: { service: "carbonsync-backend" },
  exitOnError: false,
  handleExceptions: false,
  handleRejections: false,
  transports: [
    new transports.Console({
      stderrLevels: ["error"],
      handleExceptions: false,
      handleRejections: false,
    }),
  ],
});

logger.on("error", () => {
  /* Swallow transport errors (e.g. broken stdout pipe). */
});

export const httpLogStream = {
  write: (message: string): void => {
    try {
      logger.http(message.trim());
    } catch {
      /* Never let access logging break request handling. */
    }
  },
};

let processHandlersInstalled = false;

export function installProcessErrorHandlers(): void {
  if (processHandlersInstalled) {
    return;
  }

  processHandlersInstalled = true;

  const handleFatal = (kind: "uncaughtException" | "unhandledRejection") =>
    (reason: unknown): void => {
      try {
        logger.error(`Fatal ${kind}`, { error: serializeError(reason) });
      } catch {
        /* Ignore: we are already on the fatal path. */
      }

      // brief moment to flush before exiting
      setTimeout(() => process.exit(1), 250);
    };

  process.on("uncaughtException", handleFatal("uncaughtException"));
  process.on("unhandledRejection", handleFatal("unhandledRejection"));
}

export default logger;
