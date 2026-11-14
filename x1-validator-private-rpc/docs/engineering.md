# x1-validator-private-rpc — Engineering Reference

This is the reference for how x1-validator-private-rpc works inside: its modules, apply's record, every file it reads or writes, the order its commands do things in, and its tests.

Read [`architecture.md`](architecture.md) first. It sets out the parts the tool arranges, the path of a request and of the key, and who restarts what. This reference assumes that picture and names the pieces underneath it.

Other references:

- [The feature's README](../README.md): installing, running and using the tool, the alerts it sends, and how the key is kept.
- [`docs/engineering.md`](../../docs/engineering.md): the project's gate, scripts and system test, which every feature shares.
- [`docs/npm-project-commands.md`](../../docs/npm-project-commands.md): every `npm` command.

---

## Table of Contents

- [Terminology](#terminology)
- [Commands](#commands)
- [Configuration](#configuration)
- [The Disclaimer](#the-disclaimer)
- [Engineering Design](#engineering-design)
  - [System View](#system-view)
  - [Sequence View](#sequence-view)
- [apply's Record](#applys-record)
- [Files the Tool Reads and Writes](#files-the-tool-reads-and-writes)
- [Dependencies](#dependencies)
- [ensure's Checks and Alerts](#ensures-checks-and-alerts)
- [`nginx`'s Configuration and the Key Check](#nginxs-configuration-and-the-key-check)
- [The `nginx` Upgrade Check](#the-nginx-upgrade-check)
- [The Rpc Check](#the-rpc-check)
- [Tests](#tests)
- [Security](#security)

---

## Terminology

- **The flag**: `--private-rpc`, in the validator's command in `x1console`'s start script.
- **Private rpc on or off**: the operator's choice, kept in the tool's state, of whether `ensure` keeps the flag in the start script. `apply`'s flag stage and `turn-on-private-rpc` turn it on, and `turn-off-private-rpc` turns it off. Until one of them runs, it's unset, and `ensure` treats it as off.
- **apply's record**: `app-data/what-apply-changed.json`. It holds every setting `apply` changed, with its old value, and every setting `apply` found already as it needed it. `undo-apply` puts back the old values.
- **apply's dictionary**: `app-config/app-defaults-for-user-configurable/apply-settings-dictionary.json`, which names every setting `apply` can change, with the description and type that each entry in apply's record copies.
- **The tool's state**: `app-data/state.json`, what `apply` set `nginx` up with, whether private rpc is on, and whether a saved password is stale.
- **A keyed request**: one whose path starts with the api key.
- **The gate page**: `nginx`'s local-only page, `/x1-rpc-gate`, which says `unlocked` when `nginx` holds a usable key, and `locked` when it doesn't.
- **The start wrapper**: the shell script `systemd` runs to start `nginx`, which puts the key in `nginx`'s environment.
- **The drop-in**: the `systemd` file that points `nginx`'s unit at the start wrapper.
- **The hand-off file**: the memory-only file, which the `keyHandOffPath` setting names, through which `apply` and `unlock` pass the key to the start wrapper.
- **The watchers**: the `cron` job and the tool's `git` hook in `x1console`'s checkout, both of which run `ensure`.

---

## Commands

The tool's commands, and what each does for the operator, are in the README's [Usage](../README.md#usage) section. Every `npm` command is in [`docs/npm-project-commands.md`](../../docs/npm-project-commands.md).

---

## Configuration

Every setting, its meaning and its range is in the shipped schema, `app-config/app-defaults-for-user-configurable/private-rpc.schema.json`, beside the shipped values. How an operator overrides them is in [`app-config/user-configurable/README.md`](../app-config/user-configurable/README.md). Each command reads the settings once, when it starts, through `loadSettings` in `src/lib/settings.js`.

---

## The Disclaimer

`src/lib/disclaimer.js` holds the disclaimer's text, which the README's [Disclaimer](../README.md#disclaimer) section repeats, and a test holds the two the same. The action in `src/cli/program.js` shows it before each run that can change the system: `apply` and `undo-apply` but for their dry runs, `turn-off-private-rpc`, `turn-on-private-rpc` and `unlock`. The upgrade check shows it too. `url`, `decrypt-key`, the dry runs and the rpc check change nothing. `ensure` can change the start script, but `cron` and the `git` hook run it with nobody at the terminal, as the start wrapper runs `decrypt-key`.

The host's `runOnTerminal` runs `whiptail` on the person's terminal, as a yes-or-no box whose buttons are Affirm and Decline, with Decline's focus first. The box fits the terminal, which it takes to be 80 by 24 when the terminal reports no size. `whiptail` reads the keys from stdin and draws on stderr, so stdout stays clean. It exits 0 for Affirm, 1 for Decline and 255 for Esc, and ignores Ctrl-C. Only Affirm lets the run go on. Any other ending, or a run whose stdin or stderr isn't a terminal, stops the run with exit code 1 and the reason, before it has done anything.

---

## Engineering Design

### System View

The entry point, `src/cli.js`, hands the command line to the program that `src/cli/program.js` builds. Each command's code sits in `src/cli/`. Code that the command-line tool and the two tools in `util/` share sits in `src/lib/`.

**Major functions.**

| Function | File | How it fits |
| --- | --- | --- |
| `buildProgram` | `src/cli/program.js` | Declares every command and option once, for commander. Each command gets the host, the settings, its own paths, the log and the prompts from a set of makers, which tests replace. |
| `showDisclaimer` | `src/lib/disclaimer.js` | Shows the disclaimer in `whiptail`'s dialog, before each run that can change the system, and says whether the run may go on. |
| `loadSettings` | `src/lib/settings.js` | Merges the operator's override over the shipped values, and checks the result against the schema before any command runs. |
| `runApply` | `src/cli/apply.js` | Runs the preflight, then each stage that changes something, asking first. Each stage records every setting it changes, or finds as it needs it, in apply's record. |
| `preflight` | `src/cli/apply-preflight.js` | Reads the facts the stages need, and refuses a machine it can't set up, listing every problem at once. |
| `installNginx`, `openFirewall` | `src/cli/apply-install.js` | Stages two and three: `nginx` from nginx.org, and the firewall rule. |
| `setUpKey` | `src/cli/apply-key.js` | Stage four: reads or makes the key, and offers to save the password. |
| `configureNginx` | `src/cli/apply-nginx.js` | Stage five: `nginx`'s files, then `nginx` itself, started with the key and checked from the server. |
| `editStartScript`, `installWatchers` | `src/cli/apply-watchers.js` | Stages six and seven: the flag, then the `git` hook and the `cron` job. |
| `runEnsure` | `src/cli/ensure.js` | One run of `ensure`: the flag, the checks, the alerts and the check-in. |
| `runChecks` | `src/cli/checks.js` | Reads the machine through the host, then judges what it read with pure functions. |
| `decideAlerts` | `src/cli/alerts.js` | Decides the run's alerts from the checks, the last run's alert state and the clock. Pure. |
| `readTelegram`, `sendTelegram` | `src/cli/telegram.js` | Read `x1console`'s two Telegram files, and send one alert as plain text. |
| `checkIn` | `src/cli/heartbeat.js` | Checks in with Cronitor, at the url in the project's `.env`, as many times as `cronitorCheckInTries` allows. |
| `runUndoApply` | `src/cli/undo-apply.js` | Puts back the old value of each setting apply changed, newest first. |
| `recorder`, `readRecord` | `src/cli/what-apply-changed.js` | Write and read apply's record, taking each setting's description and type from apply's dictionary. |
| `runTurnOffPrivateRpc`, `runTurnOnPrivateRpc` | `src/cli/turn-private-rpc.js` | Switch the flag, and keep the operator's choice in the tool's state. |
| `runUnlock`, `runUrl`, `runDecryptKey` | `src/cli/key-commands.js` | The commands that read the key from the vault. |
| `handKeyToNginx`, `waitForUnlocked`, `requestPathProblems` | `src/cli/nginx-gate.js` | The key's hand-over to `nginx`, and the checks of the request path from the server itself. |
| `addPrivateRpc`, `removePrivateRpc` | `src/cli/start-script.js` | Edit the start script's text, refusing any layout they can't read. Pure. |
| `renderNginxConfig` | `src/cli/render-nginx.js` | Writes `nginx`'s configuration. Pure. |
| `renderStartWrapper`, `renderDropIn`, `renderLogrotateRule`, `renderAptSource`, `renderAptPin` | `src/lib/render-host-files.js` | Write the other system files. Pure. |
| `renderGitHook`, `renderCronLine` | `src/cli/render-watchers.js` | Write the two watchers. Pure. |
| `addNginxRepository`, `removeNginxRepository` | `src/lib/nginx-repo.js` | Add nginx.org's `apt` repository with only its two pinned keys trusted, and remove it again. |
| `encryptSecret`, `decryptSecret` | `src/cli/vault.js` | Encrypt and decrypt one secret, in LP Ranger's key-store format. |
| `validateNginxUpgrade` | `util/validate-nginx-upgrade/steps.js` | The `nginx` upgrade check, the first install step. |

**Major objects.** Each is made when a command starts, and lives for that run.

| Object | File | How it fits |
| --- | --- | --- |
| The host | `src/lib/host.js` | Every effect outside the process: commands, with or without `sudo` or on the person's terminal, files, requests, name lookups and pauses. Tests pass a stand-in. |
| The settings | `src/lib/settings.js` | One merged, checked object. |
| The feature's paths | `src/cli/feature-paths.js` | Where the tool keeps its own files, found from the code's own location, so the working directory never matters. |
| apply's record | `src/cli/what-apply-changed.js` | See [apply's Record](#applys-record). |
| The tool's state | `src/cli/state.js` | What apply set `nginx` up with, and whether private rpc is on. |
| The alert state | `src/cli/alerts.js` | Each alerting check's last verdict, and the time it last alerted, or -1 when it never has. Also the messages not yet delivered. `ensure` keeps it in `app-data/alert-state.json`, and starts over from an empty one when the file is damaged. |
| The vault | `src/cli/vault.js` | Secrets by name, each encrypted with the x1-validator-services password. |
| The log | `src/cli/log.js` | Lines tagged with their stage. A secret the log is told about shows as its last four characters. |
| The prompts | `src/cli/prompts.js` | Confirmations, which `--yes` answers, and choices and passwords, which it never does. |

### Sequence View

**`apply`**, stage by stage:

1. **Preflight.** Reads the release, `systemd`'s version, the tools apply runs, `systemd`'s answer about a TPM2 chip, the rpc port from the start script, the public address and the dns resolver. Refuses, with every problem at once, when the machine isn't one the tool can set up. Changes nothing.
2. **`nginx`.** Masks `nginx.service`, so the package's default site never runs. Adds nginx.org's repository, then installs `nginx` and its two modules.
3. **Firewall.** Adds `ufw allow 443/tcp`, unless `ufw` holds a rule for that port already. That rule then stays as it is, whatever its comment, log setting or limit. A rule that closes `443/tcp` stops apply in its first stage. apply reads `ufw show added`, which lists `ufw`'s rules even while `ufw` is off.
4. **Key.** Reads the key from the vault, or makes one and stores it. Then explains `systemd`'s TPM2 answer, and asks whether to save the password. After making a key, it asks even when a password is saved, since that one opens only the old key. A yes writes the new password over it, and a no removes it. When an earlier run wrote the drop-in, the stage brings it in line at once and runs `systemctl daemon-reload`, since `systemd` reads a drop-in only then or at boot. A saved password's file comes before the drop-in names it, and a removed one goes after the drop-in stops naming it. So `apply` never stops while `systemd` expects a saved password that's gone.
5. **`nginx`'s files and start.** Writes the key check, the configuration, the start wrapper, the drop-in and the `logrotate` rule, refusing to write over a file apply didn't write. Makes `nginx`'s log folder. Has `nginx` test the configuration, then unmasks, enables and starts `nginx` with the key. Waits for the gate page to say unlocked, which takes the certificate's arrival, then checks the whole request path from the server. Skips the start when `nginx` already runs unlocked with nothing changed, unless stage 4 made a new key.
6. **The flag.** Adds `--private-rpc` to the start script, after a timestamped backup beside it, and turns private rpc on.
7. **Watchers.** Writes the `git` hook, unless another program's hook is there. Asks, then adds the `cron` line, after making the two folders it needs. When an earlier apply's hook or `cron` line names an old path to Node.js or to the tool, it replaces them without asking. Sends a test alert when `x1console`'s Telegram files are there.
8. **Hand-over.** Says to restart the validator while the running one lacks the flag, which it reads from the validator's own command line, as `ensure` does. Then it prints the url with the key masked.

**A start of `nginx`**, by `systemd` or through `unlock`:

1. `systemd` runs the start wrapper, as root, with the saved password's credential when there is one.
2. The wrapper takes the key from the hand-off file and deletes the file. Without one, and with a saved password, it runs `decrypt-key --password-stdin` as the validator's account.
3. The wrapper puts the key in the environment only when it's well formed, then runs `nginx` in its own place, with the tool's configuration.

**`unlock`** asks for the password, decrypts the key, writes it to the hand-off file through `sudo`, restarts `nginx`, and waits for the gate page to say unlocked.

**`ensure`**, one run:

1. Reads the tool's state. Before apply has set `nginx` up, it stops there, with exit code 0.
2. While private rpc is on, puts the flag back when it's missing. Every run but the `git` hook's, a run by hand included, first keeps clear of an `x1console` update. It leaves the script alone while `.git/index.lock` exists, or while the script changed less than `startScriptQuietSeconds` ago, and a later run puts the flag back. The `git` hook's run skips that check, since `git` has finished when it runs the hook.
3. Runs the checks. Unless private rpc is on, it drops the three that test the rpc is private.
4. Decides the alerts, sends them with any still pending, and writes the new alert state.
5. Checks in with Cronitor, when `.env` holds the check-in url.
6. Exits 1 when any check found a problem, and 0 otherwise.

**`turn-off-private-rpc`** asks first, then turns private rpc off in the tool's state, and only then takes the flag out of the start script. A scheduled `ensure` that runs between the two already sees the choice, and leaves the script alone. **`turn-on-private-rpc`** turns it on, and puts the flag back.

**`undo-apply`** walks apply's record newest first, and puts back the old value of each setting apply changed. It asks one question before it deletes the saved password and the key, which go together, or the key alone when no password was saved. [apply's Record](#applys-record) says what stays on record, and when the record goes.

---

## apply's Record

`apply` records every setting it changes, the moment it changes it, in `app-data/what-apply-changed.json`. It also records every setting it finds already as it needs it. `undo-apply` puts back the old value of each setting `apply` changed, newest first, and leaves the rest as they are.

```json
{
  "nginxServiceMasked": {
    "description": "Whether systemd's nginx.service is masked, so nothing can start nginx.",
    "applyChangedThisFromItsPreviousValue": true,
    "applyChangedThisValueAtThisTimestampMS": 1763078400000,
    "oldValue": "false",
    "oldValueDatatype": "boolean"
  },
  "firewallRule:443/tcp": {
    "description": "ufw's rule that lets https in, on tcp port 443.",
    "applyChangedThisFromItsPreviousValue": false,
    "applyChangedThisValueAtThisTimestampMS": -1,
    "oldValue": "true",
    "oldValueDatatype": "boolean"
  }
}
```

Each key is a setting's name in apply's dictionary, `app-config/app-defaults-for-user-configurable/apply-settings-dictionary.json`. A setting that applies to one file, folder, package, rule or `crontab` line adds `:` and that target, since the settings may have moved it by the time `undo-apply` runs. Each entry holds:

- `description`: what the setting is, copied from the dictionary.
- `applyChangedThisFromItsPreviousValue`: whether `apply` changed it, or found it as it needed it and left it.
- `applyChangedThisValueAtThisTimestampMS`: when `apply` changed it, in milliseconds since 1970, or -1 when `apply` never changed it.
- `oldValue`: its value before `apply`, as text.
- `oldValueDatatype`: how to read the old value, `string`, `integer` or `boolean`, copied from the dictionary.

Whether a file, folder, package, account, rule or line is there is a boolean setting. Today every old value is a boolean: each change `apply` makes adds or removes one thing, or switches one on or off.

A setting is recorded the moment `apply` changes it, so a stage that fails part way still leaves an exact record. The `nginx` stage records each change just before `apt` makes it, since a run can die during `apt`'s long install. A later `apply` never writes over an entry that says changed, so the old value stays the one from before the first `apply`. An entry that says found is replaced only when `apply` later changes that setting. It then moves to the end, so the record lists changes in the order they were made.

| Setting | Target | Recorded at | What `undo-apply` does |
| --- | --- | --- | --- |
| `nginxServiceMasked` | — | stages 2 and 5 | Unmasks `nginx.service`, once `nginx` is gone. Masks it, when it was masked before `apply` |
| `nginxAptKeyring`, `nginxAptSource`, `nginxAptPin` | the file | stage 2 | Removes the file. After the source, refreshes `apt`'s lists |
| `nginxAccount` | — | stage 2 | Removes the `nginx` account, once `nginx` is gone. It's recorded before the packages, so it goes after them |
| `nginxPackage` | the package | stage 2 | Purges the package, when it's installed |
| `firewallRule` | `443/tcp` | stage 3 | Runs `ufw delete allow 443/tcp` |
| `vaultFolder` | the folder | stage 4 | Removes the folder once it's empty |
| `vault` | the vault | stage 4 | Removes the vault once it holds no secret |
| `apiKey` | the vault | stage 4 | Deletes the key from the vault, once the saved password is gone. With no password saved, it asks first |
| `savedPasswordFolder` | the folder | stage 4 | Removes the folder once it's empty |
| `savedPassword` | the file | stage 4 | Asks one question for it and the api key, then deletes the saved password |
| `nginxFileFolder` | the folder | stage 5 | Removes the folder once it's empty |
| `njsModuleFile`, `nginxConfigFile`, `startWrapperFile`, `systemdDropInFile`, `logrotateRuleFile` | the file | stage 5 | Removes the file. After the drop-in, reloads `systemd` |
| `nginxLogFolder` | the folder | stage 5 | Removes the folder whole, while `nginxLogDir` still names it |
| `acmeStateFolder`, `acmeStagingStateFolder` | the folder | stage 5 | Nothing: `nginx -t` makes the folder before `apply` looks, so it's recorded as found. Purging `nginx` removes it at the shipped paths |
| `nginxServiceEnabled` | — | stage 5 | Stops and disables `nginx`, and masks it until it's gone |
| `keyHandOffFolder` | the folder | stage 5 | Removes the folder whole, while `keyHandOffPath` still puts the hand-off file there |
| `startScriptBackup` | the copy | stage 6 | Removes the copy |
| `privateRpcFlag` | the start script | stage 6 | Takes the flag out |
| `gitHook` | the hook | stage 7 | Removes the hook while it's still the tool's |
| `toolTmpFolder`, `toolLogsFolder` | the folder | stage 7 | Removes the folder whole, while it's still one of the tool's own |
| `cronLine` | the line | stage 7 | Removes that one line from the `crontab` |

A step that fails, or that the operator declines, stays in the record, and running `undo-apply` again retries it. A folder, or the vault, stays in the record too while such a change sits inside it, such as an api key the operator kept. The api key stays while the saved password does. Once nothing is left, `undo-apply` removes `app-data/`, with the record in it.

A folder removed whole goes only while the current settings still put it there, so a damaged record can never aim a removal elsewhere. The mask comes off last, and only once `nginx` is gone, so the package's default site never runs. `apply` makes the hand-off folder and the saved password's folder only when they're missing, so a folder that was there keeps its own mode.

The tool's state, `app-data/state.json`, holds the rest:

```json
{
  "version": 1,
  "setup": {
    "hostname": "x1-rpc.example.com",
    "publicIp": "203.0.113.10",
    "rpcPort": 8899,
    "staging": false
  },
  "privateRpc": "on",
  "savedPasswordStale": false
}
```

`setup` is what apply set `nginx` up with. apply's fifth stage, the one that starts `nginx`, sets it once the stage finishes, even when it finds `nginx` already running unlocked with nothing to change. `undo-apply` clears it again when it leaves anything in apply's record, and removes the file, with `app-data/`, when it leaves nothing. While `setup` is null or gone, `ensure` does nothing, and `unlock`, `url` and the two commands that switch private rpc refuse to run. `privateRpc` is the operator's choice, which `ensure` follows. `savedPasswordStale` says that a saved password is left from before the vault's newest key, and can't open it. apply's fourth stage writes it the moment that's so, before it asks whether to save the new password, and clears it once that's answered. So a run that ends at the question, Ctrl-C included, leaves the next run asking again, not taking the old password as saved.

---

## Files the Tool Reads and Writes

Paths that a setting names are given by the setting's name. Its value is in the shipped settings.

| What | Where | Written by | Read by |
| --- | --- | --- | --- |
| `nginx`'s configuration | `nginxConfigPath` | `apply` | `nginx` |
| The key check | `njsModulePath` | `apply`, from `src/njs/` | `nginx` |
| The start wrapper | `startWrapperPath` | `apply` | `systemd` |
| The drop-in | `systemdDropInPath` | `apply` | `systemd` |
| The `logrotate` rule | `logrotateRulePath` | `apply` | `logrotate` |
| `nginx`'s logs, in a folder `apply` makes that only root and `nginx` can open | `nginxLogDir` | `nginx` | the operator, through `sudo` |
| The certificates | `acmeStatePath`, and `acmeStagingStatePath` after `--acme-staging` | `nginx`'s ACME module | `nginx` |
| The saved password | `passwordCredentialPath` | `apply`, when asked | `systemd`, at each start of `nginx` |
| The hand-off file | `keyHandOffPath` | `apply`, `unlock` | the start wrapper, which deletes it |
| The vault | `vaultPath` | `apply`, `undo-apply` | `apply`, `unlock`, `url`, `decrypt-key`, `undo-apply` |
| The start script | `startScriptFile` in `x1consoleDir` | `apply`, `ensure`, `turn-off-private-rpc`, `turn-on-private-rpc`, `undo-apply` | the validator's start |
| Its backups, one for each time `apply` added the flag | beside it, ending in `.bak-` and a timestamp | `apply` | the operator |
| The `git` hook | `.git/hooks/post-merge` in `x1consoleDir` | `apply` | `git` |
| The `cron` line | the validator account's `crontab` | `apply` | `cron` |
| apply's record | `app-data/what-apply-changed.json` | `apply`, `undo-apply` | `apply`, `undo-apply` |
| apply's dictionary | `app-config/app-defaults-for-user-configurable/apply-settings-dictionary.json` | shipped with the tool | `apply` |
| The tool's state | `app-data/state.json` | `apply`, `turn-off-private-rpc`, `turn-on-private-rpc`, `undo-apply` | every command but `decrypt-key` |
| The alert state | `app-data/alert-state.json` | `ensure` | `ensure` |
| `ensure`'s lock | `tmp/ensure.lock` | `flock`, from the `cron` line | `flock` |
| `ensure`'s log | `logs/ensure.log` | the `cron` line | the operator |
| `x1console`'s Telegram files | `telegram_token.txt` and `chat_id.txt` in `x1consoleDir` | `x1console` | `ensure`, and `apply`'s test alert |
| The Cronitor url | `X1_PRIVATE_RPC_CRONITOR_URL` in the project's `.env` | the operator | `ensure` |
| The operator's settings | `app-config/user-configurable/private-rpc.json` | the operator | every command |
| The shipped settings and their schema | `private-rpc.json` and `private-rpc.schema.json` in `app-config/app-defaults-for-user-configurable/` | shipped with the tool | every command |
| nginx.org's signing keys, `apt` source and `apt` pin | `/etc/apt/keyrings/nginx-archive-keyring.gpg`, `/etc/apt/sources.list.d/nginx.sources`, `/etc/apt/preferences.d/99nginx` | `apply`, each only when it's missing, and the keys and the source only when no other `apt` entry names nginx.org's repository | `apt` |
| Let's Encrypt's staging roots | `certs/letsencrypt-staging-roots.pem` | shipped with the tool | `apply`, `ensure` and `unlock`, after `--acme-staging` |
| The release, and the dns resolver | `/etc/os-release`, `/etc/resolv.conf` | Ubuntu | `apply`'s preflight |
| The `solana` cli's settings | `~/.config/solana/cli/config.yml` | the `solana` cli | `apply`'s preflight, which refuses a cli url that names this validator |
| The running validator's command line | `/proc/<pid>/cmdline`, for the process on the rpc port | the kernel | `apply`'s hand-over and `ensure`, which check it for the flag |
| `git`'s lock in `x1console`'s checkout | `.git/index.lock` in `x1consoleDir` | `git`, during an update | `ensure`, which leaves the start script alone while it's there |

`app-data/`, `tmp/` and `logs/` sit in the feature's folder, and `git` ignores them. [`examples/`](../examples/README.md) holds what `apply` writes for the placeholder hostname and address, and a test checks each example against the tool's own output.

---

## Dependencies

The tool works through the system programs and files below, on the validator. The README's [System Programs](../README.md#system-programs) says which systems have them. The tool's Node.js packages are the runtime dependencies in the root `package.json`.

| Program or file | What the tool does with it |
| --- | --- |
| Node.js | `x1console`'s Node.js 20.0.0 runs `apply`. `apply` names that Node.js in the `cron` job, the `git` hook and the start wrapper, so it also runs their `ensure` and `decrypt-key`. |
| `nginx`, with its njs and ACME modules | Serves the keyed url. Its njs module checks the key, and its ACME module gets and renews the certificate from Let's Encrypt. `apply` installs `nginx` from nginx.org, and has `nginx -t` test the configuration before it starts `nginx`. |
| `systemd` | Runs `nginx` as `nginx.service`, with a drop-in that starts it through the start wrapper. `systemctl` masks and unmasks, enables, starts, restarts, stops and disables `nginx`, reloads `systemd` after the drop-in changes, and reads `nginx`'s state. |
| `systemd`'s encrypted credentials | `systemd-creds` saves the password, tied to the machine's TPM2 chip when there is one, and `systemd-analyze` or `systemd-creds` says whether there is. At each start of `nginx`, `systemd` hands the saved password to the start wrapper. |
| `/etc/resolv.conf` | Names the system's dns resolver, which on Ubuntu is `systemd-resolved`, at 127.0.0.53. `nginx` asks it for Let's Encrypt's address. |
| `/run` | Holds the hand-off file, in memory alone. [Files the Tool Reads and Writes](#files-the-tool-reads-and-writes) says who writes and reads it. |
| `apt` and `dpkg` | `apt` refreshes its package lists, installs `nginx` and its two modules from nginx.org's repository, and purges them for `undo-apply`. The upgrade check installs nginx.org's previous release of them, then upgrades it. `dpkg` unpacks each package, and `dpkg-query` says which version is installed. |
| `/etc/os-release` | Says the system is Ubuntu, and which release. The release's name, such as `noble`, picks nginx.org's packages. |
| `ufw` | Opens tcp port 443, lists its rules, even while `ufw` is off, and deletes the rule for `undo-apply`. |
| `gpg` | Checks that nginx.org's key file holds the two keys the tool pins, and puts only those into the keyring `apt` trusts. `gpgconf` stops `gpg`'s helpers afterwards. |
| `cron` and `flock` | `cron` runs `ensure` every minute, from the line `apply` adds with `crontab`. `flock` skips a run while the last one is still going. |
| `logrotate` | Rotates `nginx`'s logs every day, then has `nginx` reopen them. |
| `ss` | Finds what listens on a port, and so finds the validator by its rpc port. |
| `/proc` | Holds the running validator's command line. [Files the Tool Reads and Writes](#files-the-tool-reads-and-writes) says who reads it. |
| `runuser` | Lets the start wrapper, which runs as root, decrypt the key as the validator's account. |
| `git` | Runs the tool's hook in `x1console`'s checkout, after Update X1 Console pulls new commits. |
| `sudo` | Runs every step that needs root. |
| `whiptail` | Draws the disclaimer's dialog, which each run that can change the system shows first. |
| `getent` and `userdel` | `getent` tells whether the `nginx` account exists. `userdel` removes it when nginx.org's package made it, for `undo-apply` and for the upgrade check. |
| `sh`, `install`, `rm`, `grep` and the like | Handle files and folders, root's through `sudo`. |

---

## ensure's Checks and Alerts

`ensure` runs eight checks. Each reports ok, problem or unknown, with a line saying what it found:

| Check | Problem when |
| --- | --- |
| `flag-in-script` | The start script lacks the flag |
| `flag-running` | The process on the rpc port runs without the flag |
| `rpc-private` | The rpc or its websocket listens on an address other than 127.0.0.1 |
| `wrapper-paths` | The Node.js or the `src/cli.js` the start wrapper names is gone |
| `nginx-active` | `systemd` doesn't report `nginx` as active |
| `nginx-listens` | Anything but the public address's port 443 listens on port 80 or 443, or nothing listens there |
| `gate` | The gate page says locked |
| `certificate` | The certificate can't be read over tls, is for another name, or has fewer than `certificateWarningDays` left |

Every problem sets `ensure`'s exit code. An unknown verdict, such as the certificate's while `nginx` is down, keeps the check's last alert state, so one outage doesn't alert twice. Which checks alert, with each alert's wording and how often it repeats, is in the README's [Alerts](../README.md#alerts) section.

The process on the rpc port is found by that port, never by a name pattern, which could match another process.

---

## `nginx`'s Configuration and the Key Check

`renderNginxConfig` writes one `http` block with one `server`, on the public address's port 443 alone:

- One worker process, at a lower priority than the validator, `nginxWorkerPriority`.
- The ACME module's issuer, Let's Encrypt, with the tls-alpn-01 challenge. With `--acme-staging`, a second issuer, Let's Encrypt's staging service, serves the certificate instead.
- `js_set` runs the key check's `forwardPath` for every request. An empty answer means 403.
- `limit_req` gives every keyed request one shared budget: `rateLimitRequestsPerSecond` a second, plus a burst of as many more at once. A request without the key never reaches it, since it gets its 403 first.
- Keyed requests go to the rpc port on 127.0.0.1, or to the next port, the websocket's, when they ask for an upgrade.
- The access log's format writes `<key>` in place of any run of hex digits at least half a key long, in either case. It looks for that run at the start of the path, after any number of slashes. So a client's doubled slash or mistyped key never writes the key there. The keyed location writes only critical errors to its own error log.
- Request bodies of at most 10 KB, held in memory, and no response ever written to a temporary file.

The key check, `src/njs/x1-validator-private-rpc.js`, reads the key from `nginx`'s environment. It accepts only a key of the right form, and compares the request's path with it in time that doesn't depend on where they differ. Because `nginx` loads that file on its own, it keeps its own copy of the key's pattern, and its test holds the copy to `src/lib/api-key.js`.

---

## The `nginx` Upgrade Check

`util/validate-nginx-upgrade/index.js` is the first install step. It proves, on the validator itself, that an `apt` upgrade of `nginx` keeps the key. The package's binary upgrade must hand over from the old `nginx` process to the new one, with `systemd` following. The new process must still hold the key.

It installs nginx.org's previous release. It starts it the way `apply` will, through the same start wrapper and drop-in, with a throwaway key handed over through the hand-off file. Its own short-lived configuration listens on 127.0.0.1 alone and serves only the gate page. Then it upgrades with `apt`. It checks that `systemd` followed the new main process without restarting it, that the old process exited, and that the gate page still says unlocked.

Every change it makes is pushed onto an undo list, with the command that undoes it by hand. The undo list runs newest first, even after a failure or a Ctrl-C, and prints the by-hand command of any undo step that fails. `judge.js` holds its decisions, as pure functions, and `terminal.js` its output and its spinner.

It shares its repository, `apt`, `systemd` and rendering code with `apply`, from `src/lib/`, so it tests the same code `apply` runs.

---

## The Rpc Check

`util/check-my-private-rpc/index.js` tries the keyed url from outside, as a client would. It asks for the hostname, shown as it's typed, then for the key, through the same hidden prompt the commands use for the password. Before any query, `inputProblem` holds the hostname to the schema's pattern and the key to its form in `src/lib/api-key.js`.

`sendQueries`, in `check.js`, then posts `checkQueryCount` json-rpc `getSlot` queries to `https://<hostname>/<key>`, one after another, each with `requestTimeoutSeconds` to answer. Each answer is a slot, or one of these: `nginx`'s 403, 429, 502, 503 or 504, another http status, an rpc error, or something that isn't json-rpc. A request can also fail on dns, the connection or the certificate. `judge` lets the first failure explain the verdict, and `table.js` draws the report. The check never prints the key, only its last four characters: its first line and the report mask it, and its refusal of an answer that isn't a hostname doesn't quote the answer, which could be a pasted url.

---

## Tests

The feature's tests are in `test/`. Every effect goes through a stand-in host, except in the host's own tests, which run the real host in a temporary folder, with a stand-in for `sudo`. So no unit test touches the machine's own files:

- `helpers/fake-host.js`: the generic stand-in. Commands go to an answer function the test writes, files live in a map, and every call is recorded in order.
- `helpers/fake-validator.js`: a machine for the upgrade check, whose `apt`, `systemd` and `nginx` change a small state.
- `helpers/fake-x1-validator.js`: a stock `x1console` validator for `apply`, `ensure` and `undo-apply`. It has a start script and a `git` checkout, where the settings put them, and a running validator. It also has `ufw`, on or off, `cron`, and an `nginx` that answers the gate page and the keyed path once started with a key.
- `helpers/applied-validator.js`: that validator once `apply` has run on it, for the commands that come after.
- `helpers/scripted-prompts.js`: answers to confirmations, choices and passwords.
- `helpers/config-copies.js`: temporary copies of `app-config/`, so no test reads the operator's settings. One kind of copy changes every setting from its shipped value, so a test can prove the configured value is the one used.
- `helpers/fake-sudo.js`: a stand-in for `sudo`, for the host's own tests.
- `helpers/rpc-standin.js`: a stand-in for the validator's rpc, for the system test.
- `fixtures/start_validator.sh`: a start script in `x1console`'s shape. `fixtures/lp-ranger-key-store-payload.json`: a secret LP Ranger's own code encrypted, which the vault must read.

The end-to-end test, `npm run test:system`, runs the upgrade check, then `apply` and every command after it, in an LXD container. [`docs/engineering.md`](../../docs/engineering.md#the-system-test) describes it.

---

## Security

How the key and the password are kept is in the README's [Api Key Security](../README.md#api-key-security) section. The security checks the gate runs, and every exception to them, are in [`docs/security.md`](../../docs/security.md).
