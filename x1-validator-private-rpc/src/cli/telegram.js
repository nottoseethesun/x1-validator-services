/**
 * @file x1-validator-private-rpc/src/cli/telegram.js
 * @description
 * Sends the tool's alerts on Telegram, through the bot x1console already
 * uses: its token and chat id come from x1console's own two files, which
 * x1console's updates leave alone. Messages go as plain text, with no
 * parse_mode, so no character in them can make Telegram refuse one. The
 * token sits in the request's url, so the caller hides it from the log
 * before any send.
 */

import path from "node:path";
import { homePath } from "./feature-paths.js";

/** x1console's files, named by x1console. */
export const TOKEN_FILE = "telegram_token.txt";
export const CHAT_ID_FILE = "chat_id.txt";

/**
 * Reads x1console's Telegram settings.
 * @param {object} host  The host.
 * @param {object} settings  The tool's settings, for x1consoleDir.
 * @returns {{token: string, chatId: string}|null} null when either file
 *   is missing or empty, which means alerts are off.
 */
export function readTelegram(host, settings) {
  const homeDir = host.homeDir();
  const folder = homePath(settings.x1consoleDir, homeDir);
  const [token, chatId] = [TOKEN_FILE, CHAT_ID_FILE].map((name) => {
    const filePath = path.join(folder, name);
    return host.exists(filePath) ? host.readText(filePath).trim() : "";
  });
  return token === "" || chatId === "" ? null : { token, chatId };
}

/**
 * Sends one message.
 * @param {object} host  The host.
 * @param {{token: string, chatId: string}} telegram  x1console's bot.
 * @param {string} text  The message.
 * @param {number} timeoutMs  How long to wait for Telegram.
 * @returns {Promise<void>}
 * @throws {Error} When Telegram doesn't accept the message, so the
 *   caller keeps it to send again.
 */
export async function sendTelegram(host, telegram, text, timeoutMs) {
  const response = await host.postJson(
    `https://api.telegram.org/bot${telegram.token}/sendMessage`,
    { chat_id: telegram.chatId, text },
    timeoutMs,
  );
  if (response.status !== 200) {
    throw new Error(`Telegram answered http ${response.status}.`);
  }
}

/**
 * Sends the pending messages, then the new ones, keeping those that
 * couldn't be sent. A failure is logged only when a message first fails.
 * Without x1console's Telegram files, alerts are off: each new message
 * is logged as a problem, and none is kept. ensure and the key count
 * check share it.
 * @param {{host: object, settings: object,
 *   log: import("./log.js").Log}} run  The command's run.
 * @param {string[]} pending  Messages that failed before.
 * @param {string[]} fresh  New messages.
 * @returns {Promise<string[]>} The messages still pending.
 */
export async function sendAlerts({ host, settings, log }, pending, fresh) {
  const telegram = readTelegram(host, settings);
  if (telegram === undefined || telegram === null) {
    for (const message of fresh) {
      log.problem(
        "alert",
        `${message} (alerts are off: x1console's Telegram files are missing)`,
      );
    }
    return [];
  }
  log.hide(telegram.token);
  const timeoutMs = settings.requestTimeoutSeconds * 1000;
  const stillPending = [];
  for (const message of [...pending, ...fresh]) {
    try {
      await sendTelegram(host, telegram, message, timeoutMs);
      log.info("alert", message);
    } catch (error) {
      if (!pending.includes(message)) {
        log.problem(
          "alert",
          `Couldn't send "${message}": ${error.message} It goes at the next run.`,
        );
      }
      stillPending.push(message);
    }
  }
  return stillPending;
}
