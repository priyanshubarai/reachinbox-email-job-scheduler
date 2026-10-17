// Must be the FIRST import of every test file (ESM evaluates imports in source
// order, so this module body runs before any `src/` module is loaded).
import "dotenv/config";

// Isolate tests from the application environment.
// - Logical Redis DB 15: the `email-sending` queue and all `rl:` keys live
//   somewhere the app never touches, so tests cannot collide with real jobs.
// - Dead SMTP endpoint: if a mailer mock ever fails to apply, nothing can
//   leave the machine.
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";
process.env.REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:6379/15";

// Worker spacing is disabled here so worker tests are deterministic; suite C
// passes `minIntervalMs` explicitly to the limiter instead.
process.env.SENDER_MIN_INTERVAL_MS = "0";

// Tests must start unauthenticated; each fixture opts in to an identity.
delete process.env.AUTH_DEV_USER_ID;

process.env.ETHEREAL_HOST = "127.0.0.1";
process.env.ETHEREAL_PORT = "1";
