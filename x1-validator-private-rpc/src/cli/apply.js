/**
 * @file x1-validator-private-rpc/src/cli/apply.js
 * @description
 * The `apply` command: it makes the validator's rpc private and puts it
 * behind nginx, in eight stages. The first checks the machine and
 * changes nothing. Then: nginx from nginx.org, the firewall rule, the
 * api keys and the password, nginx's configuration and start, the
 * start-script flag, and the watchers that keep the flag in place. The
 * last says what to do next.
 *
 * It asks before each stage that changes something, unless given --yes.
 * Each stage skips work already done, so a second apply changes nothing.
 * Each setting apply changes is recorded the moment it changes, with its
 * old value, in app-data/what-apply-changed.json, and so is each one it
 * finds already as it needs it. So undo-apply puts back only what
 * apply changed, and nothing that was in place before. With --dry-run it
 * prints every change it would make, and makes none.
 *
 * Stages one to five never touch the validator. nginx works before the
 * flag, since the rpc already listens on every interface, the loopback
 * one included. The flag changes nothing until the validator's
 * next start, which is the operator's to choose.
 */

import { maskSecret } from "../lib/mask-secret.js";
import { installNginx, openFirewall } from "./apply-install.js";
import { checkedKey, setUpApiKeys } from "./apply-key.js";
import { configureNginx } from "./apply-nginx.js";
import { preflight } from "./apply-preflight.js";
import { editStartScript, installWatchers } from "./apply-watchers.js";
import { runningFlag } from "./checks.js";
import { RESTART_HOW, RESTART_STEPS } from "./start-script.js";
import { emptyState, readState, writeState } from "./state.js";
import {
  loadApplySettingsDictionary,
  readRecord,
  recorder,
} from "./what-apply-changed.js";

/**
 * The stages after the preflight, in order.
 * @type {{title: string, run: (context: object) => Promise<void>}[]}
 */
const STAGES = [
  { title: "install nginx from nginx.org", run: installNginx },
  { title: "open tcp port 443 in ufw", run: openFirewall },
  {
    title:
      "make the first api key when there's none, and decide whether to save the password",
    run: async (context) => {
      const { key } = await setUpApiKeys(context);
      context.key = key;
    },
  },
  {
    title: "write nginx's configuration, and start or reload it",
    run: configureNginx,
  },
  {
    title: "add --private-rpc to x1console's start script",
    run: async (context) => {
      await editStartScript(context);
      context.state.privateRpc = "on";
    },
  },
  { title: "install the git hook and the cron jobs", run: installWatchers },
];

/**
 * Makes the step that every change goes through: it runs the change and
 * says so, or in a dry run only says what it would do.
 * @param {object} log  The logger.
 * @param {boolean} dryRun  Whether this is a dry run.
 * @returns {(stage: string, what: string, action: Function) =>
 *   Promise<unknown>}
 */
function changeStep(log, dryRun) {
  return async (stage, what, action) => {
    if (dryRun === true) {
      log.info(stage, `Would ${what}.`);
      return undefined;
    }
    log.info(stage, `${what[0].toUpperCase()}${what.slice(1)}.`);
    return action();
  };
}

/**
 * Says what to do next: restart the validator, while the running one
 * lacks the flag, and what the url is. It asks the running validator
 * itself, so a run that finds the flag already in the script, after an
 * earlier run stopped short, still says to restart. A dry run says the
 * restart a real run would need, since it added no flag to restart for.
 * A key this run made shows masked here, since the fourth stage showed
 * it in full, the only time the tool can.
 * @param {object} context  The run.
 */
function handOver(context) {
  const { host, log, settings, paths, facts, dryRun } = context;
  const key = checkedKey(context.key);
  const running = runningFlag(host, facts.rpcPort);
  if (running.status === "problem") {
    log.info(
      "hand-over",
      dryRun === true
        ? `The running validator lacks --private-rpc. Since this is a dry run, you will not restart it from x1console, but in a real run, you would restart it: ${RESTART_STEPS}`
        : `The running validator lacks --private-rpc, and takes it at its next start. ${RESTART_HOW}`,
    );
  }
  log.info(
    "hand-over",
    key === ""
      ? `The rpc's url: https://${settings.hostname}/KEY, with an api key in place of KEY.`
      : `The rpc's url: https://${settings.hostname}/${maskSecret(key)}, shown in full above, and only there.`,
  );
  log.info(
    "hand-over",
    `To make more api keys, run: node ${paths.toolCli} add-api-key`,
  );
}

/**
 * Runs apply.
 * @param {object} run  What apply works with.
 * @param {object} run.host  The host.
 * @param {object} run.settings  The tool's settings.
 * @param {string} run.overridePath  The operator's settings file.
 * @param {import("./feature-paths.js").FeaturePaths} run.paths  The
 *   feature's own paths.
 * @param {import("./log.js").Log} run.log  The logger.
 * @param {import("./prompts.js").Prompts} run.prompts  The questions.
 * @param {{yes: boolean, dryRun: boolean, acmeStaging: boolean}}
 *   run.options  The command's options.
 * @param {(line: string) => void} run.out  Prints a line on stdout, as
 *   is: the new api key's urls, which the logger would mask.
 * @returns {Promise<number>} The exit code: 0 when every stage ran, 1
 *   when the operator stopped it.
 */
export async function runApply(run) {
  const { host, paths, log, prompts, options } = run;
  const dryRun = options.dryRun === true;
  const state = readState(host, paths.statePath) ?? emptyState();
  const recordPath = paths.whatApplyChangedPath;
  const whatApplyChanged = readRecord(host, recordPath) ?? new Map();
  const dictionary = loadApplySettingsDictionary();
  const context = {
    ...run,
    state,
    whatApplyChanged,
    staging: options.acmeStaging === true,
    dryRun,
    record:
      dryRun === true
        ? () => {}
        : recorder(host, recordPath, whatApplyChanged, dictionary),
    change: changeStep(log, dryRun),
    // The api key the fourth stage makes, or "" while it has made none.
    key: "",
  };
  log.info("preflight", "Checking this machine. This changes nothing.");
  context.facts = await preflight(context);
  for (const [index, stage] of STAGES.entries()) {
    const question = `Stage ${index + 2} of 8: ${stage.title}. Go on?`;
    if (dryRun === false && !(await prompts.confirm(question))) {
      log.info("apply", "Stopped. Running apply again picks up from here.");
      return 1;
    }
    const before = JSON.stringify(state);
    await stage.run(context);
    if (dryRun === false && JSON.stringify(state) !== before) {
      writeState(host, paths.statePath, state);
    }
  }
  handOver(context);
  return 0;
}
