import morgan from "morgan";
import type { Request, Response } from "express";
import { httpLogStream } from "../lib/logger.js";

const DEFAULT_IGNORED_PATHS = ["/health"];

function parseIgnoredPaths(raw: string | undefined): string[] {
  const source = raw?.trim();

  if (!source) {
    return DEFAULT_IGNORED_PATHS;
  }

  return source
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

const ignoredPaths = parseIgnoredPaths(process.env.LOG_HTTP_IGNORE_PATHS);

// Tokens are registered once per process (ESM module caching).
morgan.token<Request, Response>("path", (req) => {
  const raw = req.originalUrl || req.url || "/";
  return raw.split("?")[0] ?? raw;
});

morgan.token<Request, Response>("request-id", (req) => req.id ?? "-");

export function shouldSkipHttpLogging(path: string): boolean {
  return ignoredPaths.some((ignored) =>
    ignored.endsWith("*")
      ? path.startsWith(ignored.slice(0, -1))
      : path === ignored,
  );
}

export const httpLogger = morgan<Request, Response>(
  ":method :path :status - :response-time ms",
  {
    stream: httpLogStream,
    skip: (req) =>
      shouldSkipHttpLogging(
        (req.originalUrl || req.url || "/").split("?")[0] ?? "/",
      ),
  },
);
