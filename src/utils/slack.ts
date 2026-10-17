import logger, { serializeError } from "../lib/logger.js";

const SLACK_TIMEOUT_MS = 5000;

/**
 * Fire-and-forget Slack notification.
 *
 * Never throws and never logs the webhook URL (it is a credential). A failure to
 * notify must not affect email processing.
 */
export async function notifySlack(
  webhookUrl: string,
  text: string,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SLACK_TIMEOUT_MS);

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
      signal: controller.signal,
    });

    if (!response.ok) {
      logger.warn("Slack notification rejected", {
        status: response.status,
      });
    }
  } catch (error) {
    logger.warn("Slack notification failed", { error: serializeError(error) });
  } finally {
    clearTimeout(timer);
  }
}
