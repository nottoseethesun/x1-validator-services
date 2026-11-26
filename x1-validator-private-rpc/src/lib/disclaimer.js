/**
 * @file x1-validator-private-rpc/src/lib/disclaimer.js
 * @description
 * The disclaimer that each run able to change the system shows before it
 * does anything, as LP Ranger shows its disclosure on every launch. A run
 * of ensure is the one exception: cron and the tool's git hook run it
 * with nobody at the terminal to answer, so it never shows the
 * disclaimer, even when a person runs it. The disclaimer names the
 * project's license, puts the license's disclaimer of warranty and
 * limitation of liability in plain words, and warns that the software
 * could harm the validator it runs on. The feature's README holds the
 * same text, and a test keeps the two the same.
 *
 * It shows in a dialog that takes over the terminal until the person
 * chooses Affirm or Decline, the way a package asks about its license as
 * it installs. whiptail draws it: Ubuntu installs whiptail with the
 * system, and debconf asks its questions with it. The text ends with
 * what Affirm affirms. Decline has the focus at first, so affirming takes
 * a deliberate choice. Esc declines too, and Ctrl-C does nothing there.
 * whiptail draws on stderr, so stdout stays clean for what a command
 * prints. It needs stdin and stderr to be a terminal, and without one
 * the run can't go on.
 */

/** The disclaimer's paragraphs. whiptail wraps them to the dialog. */
export const DISCLAIMER = [
  "x1-validator-services is licensed under the Apache License, Version " +
    "2.0. The LICENSE file at the project's root holds its full text.",
  "That license says the software is provided as is, without warranties " +
    "or conditions of any kind, express or implied. That includes any " +
    "warranties or conditions of title, non-infringement, merchantability " +
    "or fitness for a particular purpose. You alone are responsible for " +
    "deciding whether it's right to use or share it, and you take on any " +
    "risks of doing so.",
  "The license also says that no contributor is liable to you for " +
    "damages, under any legal theory, whether in tort, negligence " +
    "included, in contract or otherwise. That covers direct, indirect, " +
    "special, incidental and consequential damages of any kind that come " +
    "from the license, or from using the software or being unable to use " +
    "it. Among them are lost goodwill, work stoppage, a computer's failure " +
    "or malfunction, and any other commercial damages or losses. It holds " +
    "even when a contributor was told such damages could happen.",
  "Both hold unless the law requires otherwise, as it can for deliberate " +
    "and grossly negligent acts, or unless otherwise agreed in writing.",
  "This software could, although its authors have made all best efforts " +
    "to the contrary, cause your validator to exhibit degraded performance " +
    "or even stop working.",
];

/** What choosing Affirm affirms: the dialog's last line. */
export const AFFIRMATION = "I have read and understood the above Disclaimer.";

/** The dialog's two buttons. */
export const AFFIRM_BUTTON = "Affirm";
export const DECLINE_BUTTON = "Decline";

/** Why a run stops when the person chooses Decline, or presses Esc. */
export const DECLINED = "You declined the disclaimer.";

/** Why a run stops when there's no terminal to show the dialog in. */
export const NO_TERMINAL =
  "The disclaimer needs a terminal to show in, and stdin or stderr isn't one.";

/** Why a run stops when whiptail can't show the dialog. */
export const NOT_SHOWN = "whiptail, which shows the disclaimer, couldn't run.";

/** The size taken when the terminal reports none, as a fresh pty does. */
const FALLBACK_SIZE = { columns: 80, rows: 24 };

/**
 * The dialog's widest, so its lines stay easy to read, and its smallest,
 * where whiptail can still draw both buttons.
 */
const MAX_WIDTH = 76;
const MIN_WIDTH = 30;
const MIN_HEIGHT = 8;

/**
 * Reads the terminal's size, or takes the fallback when it reports none.
 * @param {{columns?: number, rows?: number}} output  The terminal.
 * @returns {{columns: number, rows: number}}
 */
function sizeOf({ columns, rows }) {
  const known = (count) => count !== undefined && count !== null && count > 0;
  return known(columns) && known(rows) ? { columns, rows } : FALLBACK_SIZE;
}

/**
 * Builds whiptail's arguments for the dialog: a yes-or-no box whose
 * buttons are Affirm and Decline, with Decline's focus first. It fills
 * the terminal but for a margin, which holds the box's shadow, and the
 * text scrolls when the box can't hold it all.
 * @param {{columns: number, rows: number}} size  The terminal's size.
 * @returns {string[]}
 */
export function dialogArgs({ columns, rows }) {
  const width = Math.max(MIN_WIDTH, Math.min(columns - 4, MAX_WIDTH));
  const height = Math.max(MIN_HEIGHT, rows - 4);
  return [
    "--title",
    "Disclaimer",
    "--yes-button",
    AFFIRM_BUTTON,
    "--no-button",
    DECLINE_BUTTON,
    "--defaultno",
    "--scrolltext",
    "--yesno",
    [...DISCLAIMER, AFFIRMATION].join("\n\n"),
    String(height),
    String(width),
  ];
}

/**
 * Shows the disclaimer, and waits for the person to choose.
 * @param {object} host  The host, which runs whiptail on the terminal.
 * @param {{input?: {isTTY?: boolean}, output?: {isTTY?: boolean,
 *   columns?: number, rows?: number}}} [terminal]  Where the person
 *   types and the dialog draws: stdin and stderr, unless a test passes
 *   stand-ins.
 * @returns {string} "" once the person affirms the disclaimer, or why the
 *   run can't go on.
 */
export function showDisclaimer(host, terminal = {}) {
  const input = terminal.input ?? process.stdin;
  const output = terminal.output ?? process.stderr;
  if (input.isTTY !== true || output.isTTY !== true) {
    return NO_TERMINAL;
  }
  const status = host.runOnTerminal("whiptail", dialogArgs(sizeOf(output)));
  if (status === 0) {
    return "";
  }
  // whiptail exits 1 for the No button, here Decline, and 255 for Esc.
  return status === 1 || status === 255 ? DECLINED : NOT_SHOWN;
}
