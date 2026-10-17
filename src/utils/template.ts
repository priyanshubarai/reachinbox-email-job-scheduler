/**
 * Minimal, documented personalization.
 *
 * Only the tokens listed in {@link SUPPORTED_TOKENS} are substituted. Anything
 * else (for example `{{firstName}}`) is passed through untouched so a caller can
 * see that it was not expanded instead of silently losing data.
 */

export const SUPPORTED_TOKENS = ["name", "email"] as const;

export type SupportedToken = (typeof SUPPORTED_TOKENS)[number];

export interface TemplateContext {
  /** Recipient display name. Missing/blank renders as an empty string. */
  name?: string | null;
  /** Recipient email address. */
  email: string;
}

const TOKEN_PATTERN = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

export function renderTemplate(
  template: string,
  context: TemplateContext,
): string {
  return template.replace(TOKEN_PATTERN, (match, token: string) => {
    if (token === "name") {
      return context.name?.trim() ?? "";
    }

    if (token === "email") {
      return context.email;
    }

    return match;
  });
}

export function renderSubjectAndBody(
  subject: string,
  body: string,
  context: TemplateContext,
): { subject: string; body: string } {
  return {
    subject: renderTemplate(subject, context),
    body: renderTemplate(body, context),
  };
}
