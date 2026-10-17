import { mock } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * Registers a mailer mock that replaces `src/utils/mailer.js` for every
 * importer in this process (the real worker pulls it in statically).
 *
 * IMPORTANT: `mock.module` only takes effect for modules linked AFTER the
 * registration, so callers must `await import()` the worker rather than
 * importing it statically at the top of a test file.
 */

export interface SentMail {
  messageId: string;
  from: string;
  to: string;
  subject: string;
  text: string;
}

const calls: SentMail[] = [];

const here = dirname(fileURLToPath(import.meta.url));
const mailerUrl = pathToFileURL(resolve(here, "../../src/utils/mailer.js")).href;

mock.module(mailerUrl, {
  namedExports: {
    mailer: {
      async sendMail(mail: {
        from: string;
        to: string;
        subject: string;
        text: string;
      }): Promise<Record<string, unknown>> {
        const messageId = `mock-${calls.length + 1}@reachinbox.test`;
        calls.push({
          messageId,
          from: mail.from,
          to: mail.to,
          subject: mail.subject,
          text: mail.text,
        });
        return {
          messageId,
          accepted: [mail.to],
          rejected: [],
          envelope: { mailfrom: mail.from, rcptTo: [mail.to] },
          // No "STATUS=]/" bracket, so `getTestMessageUrl` returns false.
          response: "250 OK: mock transport accepted message",
        };
      },
    },
  },
});

/** Every `sendMail` the worker performed, in order. */
export function sentMails(): SentMail[] {
  return [...calls];
}

export function resetMailerMock(): void {
  calls.length = 0;
}
