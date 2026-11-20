# x1-validator-private-rpc — Engineering Reference

This is the reference for how x1-validator-private-rpc works inside: its modules, apply's record, every file it reads or writes, the order its commands do things in, and its tests.

Read [`architecture.md`](architecture.md) first. It sets out the parts the tool arranges, the path of a request and of the keys, and who restarts what. This reference assumes that picture and names the pieces underneath it.

Other references:

- [The feature's README](../README.md): installing, running and using the tool, the alerts it sends, and how the keys are kept.
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
- [Integration with `x1console`](#integration-with-x1console)
  - [The Start Script](#the-start-script)
  - [The `git` Hook](#the-git-hook)
  - [The Telegram Set-up](#the-telegram-set-up)
- [ensure's Checks and Alerts](#ensures-checks-and-alerts)
- [`nginx`'s Configuration and the Key Check](#nginxs-configuration-and-the-key-check)
- [The `nginx` Upgrade Check](#the-nginx-upgrade-check)
- [The Rpc Check](#the-rpc-check)
- [Tests](#tests)
- [Security](#security)

---

## Terminology

- **The flag**: `--private-rpc`, in the validator's command in `x1console`'s start script.
- **Private rpc on or off**: the operator's choice, kept in the tool's state, of whether `ensure` keeps the flag in the start script. `apply`'s flag stage and `turn-on-private-rpc` turn it on, and `turn-off-private-rpc` turns it off. It starts unset, and `undo-apply` unsets it again. While it's unset, `ensure` treats it as off.
- **apply's record**: `app-data/what-apply-changed.json`. It holds every setting of the machine `apply` changed, such as whether a file is there, with its old value. It also holds every one `apply` found already in the state it needs, such as a firewall rule for port 443 that was there before. `undo-apply` puts back the old values of the ones `apply` changed.
- **apply's dictionary**: `app-config/app-defaults-for-user-configurable/apply-settings-dictionary.json`, which names every setting `apply` can change, with the description and type that each entry in apply's record copies.
- **The tool's state**: `app-data/state.json`, what `apply` set `nginx` up with, whether private rpc is on, and whether a saved password is stale, left from an earlier api keys' file.
- **A keyed request**: one whose path starts with an api key whose hash is in `nginx`'s list.
- **The api keys' file**: `hashed-api-keys.json`, which the `hashedApiKeysPath` setting names. It holds each key's SHA-256 hash, unencrypted, with the key's record, whose values the x1-validator-services password encrypts.
- **`nginx`'s list**: `hashed-api-keys.map`, which the `hashedApiKeysMapPath` setting names, with one `<hash> 1;` line per key. `nginx`'s map includes it.
- **The key count check**: `ensure-there-is-at-least-one-rpc-api-key`, which a `cron` line of its own runs every `apiKeyCountCheckHours` hours.
- **The gate page**: `nginx`'s local-only page, `/x1-rpc-gate`, which says `ok` to requests from the machine itself.
- **The drop-in**: the `systemd` file that has `nginx`'s unit start `nginx` with the tool's configuration and its own read-only `/dev`, after making `nginx`'s log folder when it's missing.
- **The watchers**: the `cron` job that runs `ensure` every minute, and the tool's `git` hook in `x1console`'s checkout, which runs it after an update.

---

## Commands

The tool's commands, and what each does for the operator, are in the README's [Usage](../README.md#usage) section. Every `npm` command is in [`docs/npm-project-commands.md`](../../docs/npm-project-commands.md).

---

## Configuration

Every setting, its meaning and its range is in the shipped schema, `app-config/app-defaults-for-user-configurable/private-rpc.schema.json`, beside the shipped values. How an operator overrides them is in [`app-config/user-configurable/README.md`](../app-config/user-configurable/README.md). Each command reads the settings once, when it starts, through `loadSettings` in `src/lib/settings.js`.

Since json has no comments, a key that starts with `_` is a note, such as the warnings beside `hashedApiKeysPath` and `hashedApiKeysMapPath` in the shipped values. The schema allows notes, and `loadSettings` leaves them out.

---

## The Disclaimer

`src/lib/disclaimer.js` holds the disclaimer's text, which the README's [Disclaimer](../README.md#disclaimer) section repeats, and a test holds the two the same. The action in `src/cli/program.js` shows it before each run that can change the system, and the upgrade check shows it too. The README's section says which runs those are, and how to answer the dialog.

The host's `runOnTerminal` runs `whiptail` on the person's terminal, as a yes-or-no box whose buttons are Affirm and Decline. The box fits the terminal, which it takes to be 80 by 24 when the terminal reports no size. `whiptail` reads the keys from stdin and draws on stderr, so stdout stays clean. It exits 0 for Affirm, 1 for Decline and 255 for Esc, and ignores Ctrl-C. Only Affirm lets the run go on. Any other ending, or a run whose stdin or stderr isn't a terminal, stops the run with exit code 1 and the reason, before it has done anything.

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
| `runApply` | `src/cli/apply.js` | Runs the preflight, then each stage that changes something, asking first. Each stage records every setting it changes, or finds already in the state it needs, in apply's record. |
| `preflight` | `src/cli/apply-preflight.js` | Reads the facts the stages need, and refuses a machine it can't set up, listing every problem at once. |
| `installNginx`, `openFirewall` | `src/cli/apply-install.js` | Stages two and three: `nginx` from nginx.org, and the firewall rule. |
| `setUpApiKeys` | `src/cli/apply-key.js` | Stage four: makes the first key when the file holds none, shows it once, hands `nginx` the list of hashes, and offers to save the password. |
| `configureNginx` | `src/cli/apply-nginx.js` | Stage five: `nginx`'s files, then `nginx` itself, started or reloaded, and checked from the server. |
| `editStartScript`, `installWatchers` | `src/cli/apply-watchers.js` | Stages six and seven: the flag, then the `git` hook and the two `cron` lines. |
| `runEnsure` | `src/cli/ensure.js` | One run of `ensure`: the flag, the checks, the alerts and the check-in. |
| `runChecks` | `src/cli/checks.js` | Reads the machine through the host, then judges what it read with pure functions. |
| `decideAlerts` | `src/cli/alerts.js` | Decides the run's alerts from the checks, the last run's alert state and the clock. Pure. |
| `readTelegram`, `sendTelegram`, `sendAlerts` | `src/cli/telegram.js` | Read `x1console`'s two Telegram files, send one alert as plain text, and send a run's alerts, keeping those Telegram didn't take. `ensure` and the key count check share `sendAlerts`. |
| `checkIn` | `src/cli/heartbeat.js` | Checks in with Cronitor, at the url in the project's `.env`, as many times as `cronitorCheckInTries` allows. |
| `runUndoApply` | `src/cli/undo-apply.js` | Puts back the old value of each setting apply changed, newest first. |
| `recorder`, `readRecord` | `src/cli/what-apply-changed.js` | Write and read apply's record, taking each setting's description and type from apply's dictionary. |
| `runTurnOffPrivateRpc`, `runTurnOnPrivateRpc` | `src/cli/turn-private-rpc.js` | Switch the flag, and keep the operator's choice in the tool's state. |
| `lockStartScript`, `withStartScriptLock` | `src/cli/state.js` | The start script's lock, which `ensure`, `turn-off-private-rpc` and `undo-apply`'s step that takes the flag out hold. |
| `runAddApiKey` | `src/cli/add-api-key.js` | Makes keys, adds their encrypted records, shows each key once, and hands `nginx` the list. |
| `runRemoveApiKey` | `src/cli/remove-api-key.js` | Removes a pasted key's hash and record, and hands `nginx` the list. |
| `runUrl` | `src/cli/key-commands.js` | Prints the url's two forms, and how many keys `nginx`'s list holds. |
| `runEnsureApiKey` | `src/cli/ensure-there-is-at-least-one-rpc-api-key.js` | Counts `nginx`'s list, and alerts while it's empty. |
| `newHashedApiKeys`, `openHashedApiKeys`, `addNewKey`, `handListToNginx`, `withApiKeysLock`, `askSudoFirst` | `src/cli/hashed-api-keys.js` | The api keys' file and its records' encryption. The writing of `nginx`'s list, and the reload that has `nginx` read it, after making `nginx`'s log folder when it's missing. The api keys' lock, and the `sudo` that the key commands and `undo-apply` get before their first change. |
| `withFolderLock` | `src/cli/folder-lock.js` | Runs a change while holding `flock`'s lock on a folder, and refuses when another command holds it. The start script's lock and the api keys' lock both use it. |
| `hashApiKey`, `mapText`, `countMapLines` | `src/lib/key-hash-map.js` | A key's hash, and the form of `nginx`'s list, which the upgrade check shares. |
| `waitForGate`, `requestPathProblems` | `src/cli/nginx-gate.js` | The checks of the request path from the server itself. |
| `addPrivateRpc`, `removePrivateRpc` | `src/cli/start-script.js` | Edit the start script's text, refusing any layout they can't read. Pure. |
| `renderNginxConfig` | `src/cli/render-nginx.js` | Writes `nginx`'s configuration. Pure. |
| `renderDropIn`, `renderAptSource`, `renderAptPin` | `src/lib/render-host-files.js` | Write the other system files. Pure. |
| `renderGitHook`, `renderCronLine`, `renderKeyCountCronLine` | `src/cli/render-watchers.js` | Write the two watchers, and the key count check's `cron` line. Pure. |
| `addNginxRepository`, `removeNginxRepository` | `src/lib/nginx-repo.js` | Add nginx.org's `apt` repository with only its two pinned keys trusted, and remove it again. |
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
| The api keys' file | `src/cli/hashed-api-keys.js` | Each key's hash, with its record's values encrypted. |
| The log | `src/cli/log.js` | Lines tagged with their stage. A secret the log is told about shows as its last four characters. |
| The prompts | `src/cli/prompts.js` | Confirmations, which `--yes` answers, and choices, lines such as an email, and passwords, which `--yes` never answers. |

### Sequence View

**`apply`**, stage by stage:

1. **Preflight.** Reads the release, `systemd`'s version, the tools apply runs, `systemd`'s answer about a TPM2 chip, the rpc port from the start script, the public address and the dns resolver. Refuses, with every problem at once, when the machine isn't one the tool can set up. Changes nothing.
2. **`nginx`.** Masks `nginx.service`, so the package's default site never runs. Adds nginx.org's repository, then installs `nginx` and its two modules.
3. **Firewall.** Adds `ufw allow 443/tcp`, unless `ufw` holds a rule for that port already. That rule then stays as it is, whatever its comment, log setting or limit. A rule that closes `443/tcp` stops apply in its first stage. apply reads `ufw show added`, which lists `ufw`'s rules even while `ufw` is off.
4. **The api keys and the password.** What it does depends on whether the api keys' file holds a key yet. It records its writes the same way in both cases.
   - **No key in the file.** It makes one. First it asks for the password: the file's own, or a new one, typed twice, when there's no file yet. It adds the key's record, its values encrypted, and writes the file. Then it prints the key's two urls, the only time any command shows the key, so a run that stops later still showed it. Next it writes `nginx`'s list from the file's hashes, and reloads `nginx` if it's running. Then it explains `systemd`'s TPM2 answer, and asks whether to save the password. It asks the save question even when a password is saved already, if that password is left from an earlier file, since the saved password can't open the new file. A yes writes the new password over it, and a no removes it.
   - **Keys in the file already.** It writes `nginx`'s list, and reloads a running `nginx`, only when the list differs from the file's hashes, and asks nothing. The exception is a saved password marked stale in the tool's state, which means an earlier run stopped at the question that would replace it. Then it asks for the password, and the save question again.
   - **What it records.** Before its writes, it records each folder they make, and the list. It records a saved password once it's saved, and an old one before it removes it.
5. **`nginx`'s files and start.** Its work comes in three parts, in this order.
   - **Files.** It writes the key check, the configuration and the drop-in, each only when it's missing or differs, refusing to write over a file apply didn't write. It makes `nginx`'s log folder again if it's gone, as nginx.org's package makes it, and doesn't record it, since purging the package removes it.
   - **Test and start.** When it wrote a file, or `nginx` is stopped or doesn't answer, it has `nginx -t` test the configuration. When `nginx -t` refuses, the stage puts back every file it wrote as it was, removing any it made new. It keeps what it wrote, and why `nginx` refused it, in `logs/error.log`, and stops. [Setting Up and Taking Down](architecture.md#setting-up-and-taking-down) says why. Otherwise it runs `systemctl daemon-reload`, and unmasks and enables `nginx.service`, recording whether it was masked and enabled before. Then it starts `nginx` when it's stopped, restarts it when the drop-in changed or it doesn't answer, and otherwise reloads it.
   - **Check.** Unless it left `nginx` as it was and stage 4 made no key, it waits for the gate page to say ok, which it can only once the certificate has arrived. Then it checks the whole request path from the server: the new key when stage 4 made one, a path without a key, and a random key. It runs the checks again until they pass, for up to `certificateWaitSeconds`, since a reload takes a moment.
6. **The flag.** Adds `--private-rpc` to the start script, after a timestamped backup beside it, and turns private rpc on.
7. **Watchers.** Writes the `git` hook, unless another program's hook is there. Asks, then adds the two `cron` lines, after making the two folders they write in. Each line also makes its folders whenever they're missing. When the tool's `git` hook names an old path to Node.js or to the tool, it writes the hook again. It replaces any `cron` line an earlier `apply` installed that this version writes differently, without asking. Sends a test alert when `x1console`'s Telegram files are there.
8. **Hand-over.** Says to restart the validator while the running one lacks the flag, which it reads from the validator's own command line, as `ensure` does. Then it prints the url, with the key masked when this run made it, or with `KEY` in its place.

**A start of `nginx`**, by `systemd`: `nginx` starts with the tool's configuration, which includes its list of hashes. It needs nothing else.

**`add-api-key`** checks its options and the room under `maxApiKeys`, then asks for the password and checks it against the file's `passwordCheck`. It asks for one email, which it gives to every key it makes, and asks again until the answer is an email address or empty. It makes the keys and adds their records. It gets `sudo`, then writes the file, prints each key's urls, and writes `nginx`'s list and reloads `nginx`.

**`remove-api-key`** asks for a key at a hidden prompt, checks its form, and hashes it. A hash that isn't in the file removes nothing, and the command exits 1. Removing the last key asks first. It gets `sudo`, then writes `nginx`'s list without the hash and reloads `nginx`, and last writes the file without the hash and its record. [The Keys' Path](architecture.md#the-keys-path) says why `sudo` comes first and the list before the file.

**The key count check** reads the tool's state, and does nothing before apply has set `nginx` up. It counts `nginx`'s list, and with no key, sends the alert, logs it, and exits 1.

**`ensure`**, one run:

1. Reads the tool's state. Before apply has set `nginx` up, it stops there, with exit code 0.
2. Takes the start script's lock, reads whether private rpc is on, and holds the lock until it has put the flag back or left it. While another command holds the lock, the run changes nothing and exits 0. While private rpc is on, it puts the flag back when it's missing. Every run but the `git` hook's, a run by hand included, first keeps clear of an `x1console` update. It leaves the script alone while `.git/index.lock` exists, or while the script changed less than `startScriptQuietSeconds` ago, and a later run puts the flag back. The `git` hook's run skips that check, since the merge is done when `git` runs the hook.
3. Runs the checks. Unless private rpc is on, it drops the three that test the rpc is private.
4. Decides the alerts, sends them with any still pending, and writes the new alert state.
5. Checks in with Cronitor, when `.env` holds the check-in url.
6. Exits 1 when any check found a problem, and 0 otherwise.

**`turn-off-private-rpc`** asks first, then takes the start script's lock, reads the state and the script again, turns private rpc off in the state, and takes the flag out of the script. Then, when the script still carries the flag, it says so. Otherwise it says what the validator's next start changes, unless the running validator lacks the flag already. When `ensure` or `undo-apply` holds the lock, it refuses and changes nothing. [Switching](architecture.md#switching) says why. **`turn-on-private-rpc`** turns it on, and puts the flag back. It needs no lock, since it only adds the flag, as `ensure` does.

**`undo-apply`** first asks one question, while the api keys' file is there: whether to delete every key, and the saved password with them when apply's record shows apply saved it. A yes gets `sudo` first, as the key commands do, then deletes the file. After a no, apply's record keeps its entries for the saved password, the folder that holds it, and the folder of the kept api keys' file, and `undo-apply` leaves all three in place. Then it walks apply's record newest first, and puts back the old value of each setting apply changed. Once it has taken the flag out, it says what the validator's next start changes, unless the running validator lacks the flag already. After its steps, it says so when the start script keeps a flag `apply` didn't add. It never removes a package, so while `nginx` is installed, it keeps `nginx`'s packages, account, repository and mask on record, and says how the operator can purge `nginx`. [apply's Record](#applys-record) says what else stays on record, and when the record goes.

---

## apply's Record

`apply` records every setting it changes on the machine, the moment it changes it, in `app-data/what-apply-changed.json`. Such a setting is, for example, whether a file, folder, package, account, rule or line is there: a boolean. It also records every setting it finds already in the state it needs, such as a firewall rule for port 443 that was there before. `undo-apply` puts back the old value of each setting `apply` changed, newest first, and leaves the rest as they are. It never removes a package, though. While `nginx` is installed, its packages stay on record. A later `apply` refuses an installed `nginx` unless the record shows `apply` installed it. With these entries, a later `apply` takes that `nginx` as its own. `nginx`'s account, nginx.org's repository and the mask stay with them, and go once `nginx` is gone, as the table below says.

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

Each entry's name is a setting's name in apply's dictionary, `app-config/app-defaults-for-user-configurable/apply-settings-dictionary.json`. A setting that applies to one file, folder, package, rule or `crontab` line adds `:` and that target, since the operator may have moved that target in the tool's settings by the time `undo-apply` runs. Each entry holds:

- `description`: what the setting is, copied from the dictionary.
- `applyChangedThisFromItsPreviousValue`: whether `apply` changed it, or found it already in the state it needs and left it.
- `applyChangedThisValueAtThisTimestampMS`: when `apply` changed it, in milliseconds since 1970, or -1 when `apply` never changed it.
- `oldValue`: its value before `apply`, as text.
- `oldValueDatatype`: how to read the old value, `string`, `integer` or `boolean`, copied from the dictionary.

Today every old value is a boolean: each change `apply` makes adds or removes one thing, or switches one on or off.

A setting is recorded the moment `apply` changes it, so a stage that fails part way still leaves an exact record. The `nginx` stage records each change just before `apt` makes it, since a run can die during `apt`'s long install. A later `apply` never writes over an entry that says changed, so the old value stays the one from before the first `apply`. An entry that says found is replaced only when `apply` later changes that setting. It then moves to the end, so the record lists changes in the order they were made.

| Setting | Target | Recorded at | What `undo-apply` does |
| --- | --- | --- | --- |
| `nginxServiceMasked` | — | stages 2 and 5 | When it was masked before `apply`, masks it again. Otherwise, while `nginx` is installed, keeps it on record, so the mask stays, and once `nginx` is gone, unmasks `nginx.service` |
| `nginxAptKeyring`, `nginxAptSource`, `nginxAptPin` | the file | stage 2 | While `nginx` is installed, keeps it on record, so the file stays, for `nginx`'s updates. Once `nginx` is gone, removes the file. After the source, refreshes `apt`'s lists |
| `nginxAccount` | — | stage 2 | While `nginx` is installed, keeps it on record. Once `nginx` is gone, removes the `nginx` account. It's recorded before the packages, so it goes after them |
| `nginxPackage` | the package | stage 2 | Never removes the package. While it's installed, keeps it on record, and for `nginx` itself, says what stays and how the operator can purge it. Once it isn't installed, after the operator's purge or a removal by hand, says it isn't installed, and takes it off the record. For `nginx` itself, it adds that after `apt remove`, `sudo apt purge nginx` would delete what's left |
| `firewallRule` | `443/tcp` | stage 3 | Runs `ufw delete allow 443/tcp` |
| `hashedApiKeysFolder` | the folder | stage 4 | Removes the folder once it's empty |
| `savedPasswordFolder` | the folder | stage 4 | Removes the folder once it's empty |
| `savedPassword` | the file | stage 4 | Deletes the saved password, unless the answer to the one question kept the keys |
| `nginxFileFolder` | the folder | stages 4 and 5 | Removes the folder once it's empty |
| `hashedApiKeysMapFile` | the file | stage 4 | Removes `nginx`'s list, whatever the answer to the one question, since `apply` writes it again from the api keys' file |
| `njsModuleFile`, `nginxConfigFile`, `systemdDropInFile` | the file | stage 5 | Removes the file. After the drop-in, reloads `systemd` |
| `acmeStateFolder`, `acmeStagingStateFolder` | the folder | stage 5 | Nothing: `nginx -t` makes the folder before `apply` looks, so it's recorded as found. A purge of `nginx` by the operator removes it at the shipped paths |
| `nginxServiceEnabled` | — | stage 5 | When `nginx` is installed, stops and disables it, and masks it until it's gone |
| `startScriptBackup` | the copy | stage 6 | Removes the copy |
| `privateRpcFlag` | the start script | stage 6 | Takes the flag out, holding the start script's lock |
| `gitHook` | the hook | stage 7 | Removes the hook while it's still the tool's |
| `toolTmpFolder`, `toolLogsFolder` | the folder | stage 7, or stage 5 for `logs/` when `nginx -t` refuses | Removes the folder whole, while it's still one of the tool's own |
| `cronLine` | the line | stage 7 | Removes that one line from the `crontab`. There's one entry for `ensure`'s line, and one for the key count check's |

The api keys themselves aren't in the record, since `add-api-key` and `remove-api-key` change them between runs of `apply`. `undo-apply`'s one question decides them, as the [Sequence View](#sequence-view) says.

A step that fails stays in the record, and so does the saved password's step after a no to the one question. Running `undo-apply` again retries them. `nginx`'s entries stay too, while `nginx` is installed, and go at the first run after the operator purges it. A folder also stays in the record while something inside it stays: such a step's target, or the api keys' file the operator kept. Once nothing is left, `undo-apply` removes `app-data/`, with the record in it.

A folder removed whole goes only while the current settings still put it there, so a damaged record can never aim a removal elsewhere. The mask comes off last, and only once `nginx` is gone, so the package's default site never runs. `apply` makes the saved password's folder only when it's missing, so a folder that was there keeps its own mode.

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

`setup` is what apply set `nginx` up with. apply's fifth stage, the one that starts `nginx`, sets it once the stage finishes, even when it finds `nginx` already answering with nothing to change. `undo-apply` clears it again when it leaves anything in apply's record, and removes the file, with `app-data/`, when it leaves nothing. While `setup` is null or gone, `ensure` and the key count check do nothing. `url`, `add-api-key`, `remove-api-key` and the two commands that switch private rpc refuse to run then.

`privateRpc` is the operator's choice, which `ensure` follows: `"on"`, `"off"`, or `""` while it's unset. `undo-apply` unsets it whenever it clears `setup`, so that no `ensure` adds the flag before `apply` does. A later `apply` sets `setup` again at its fifth stage, which starts `nginx`, and from then on `ensure` acts on the choice. But `apply` adds the flag only at its sixth stage, and installs the `cron` job and the `git` hook that run `ensure` only at its seventh. So after an `apply` that stopped between its fifth and sixth stages, a choice left on would have an `ensure` run by hand add the flag. A later `apply` would find that flag and record it as found, not as its own change. `undo-apply` takes back only `apply`'s changes, so it would leave the flag.

`savedPasswordStale` says that a saved password is left from an earlier api keys' file, and can't open this one. apply's fourth stage writes it before it asks whether to save the new password, and clears it once that's answered. So a run that ends at the question, Ctrl-C included, leaves the next run asking again, not taking the old password as saved.

---

## Files the Tool Reads and Writes

Paths that a setting names are given by the setting's name. Its value is in the shipped settings.

| What | Where | Written by | Read by |
| --- | --- | --- | --- |
| `nginx`'s configuration | `nginxConfigPath` | `apply` | `nginx` |
| The key check | `njsModulePath` | `apply`, from `src/njs/` | `nginx` |
| `nginx`'s list of the keys' hashes | `hashedApiKeysMapPath` | `apply`, `add-api-key`, `remove-api-key` | `nginx`, at each start and reload, `apply`, to compare it with the api keys' file, `url` and the key count check |
| The drop-in | `systemdDropInPath` | `apply` | `systemd` |
| `nginx`'s logs, `access.log` and `error.log`, in nginx.org's folder for them, which `apply`, the drop-in and the key commands make again when it's missing | `/var/log/nginx` | `nginx` | the operator, through `sudo` or the `adm` group |
| The certificates | `acmeStatePath`, and `acmeStagingStatePath` after `--acme-staging` | `nginx`'s ACME module | `nginx` |
| The saved password | `passwordCredentialPath` | `apply`, when asked | nothing yet: it's there for reading the records unattended, for the rotation notices and billing to come |
| The api keys' file | `hashedApiKeysPath` | `apply`, `add-api-key`, `remove-api-key` | `apply`, `add-api-key`, `remove-api-key` |
| The start script | `startScriptFile` in `x1consoleDir` | `apply`, `ensure`, `turn-off-private-rpc`, `turn-on-private-rpc`, `undo-apply` | the validator's start, and each command that writes it |
| Its backups, one for each time `apply` added the flag | beside it, ending in `.bak-` and a timestamp | `apply` | the operator |
| The `git` hook | `.git/hooks/post-merge` in `x1consoleDir` | `apply` | `git` |
| The two `cron` lines | the validator account's `crontab` | `apply` | `cron` |
| apply's record | `app-data/what-apply-changed.json` | `apply`, `undo-apply` | `apply`, `undo-apply` |
| apply's dictionary | `app-config/app-defaults-for-user-configurable/apply-settings-dictionary.json` | shipped with the tool | `apply` |
| The tool's state | `app-data/state.json` | `apply`, `turn-off-private-rpc`, `turn-on-private-rpc`, `undo-apply` | every command |
| The alert state | `app-data/alert-state.json` | `ensure` | `ensure` |
| `ensure`'s lock | `tmp/ensure.lock` | `flock`, from `ensure`'s `cron` line | `flock` |
| The api keys' lock, on the folder of the api keys' file, with no file of its own | `hashedApiKeysPath`'s folder | `flock`, from `apply`, `add-api-key`, `remove-api-key` and `undo-apply` | `flock` |
| The start script's lock, on the folder of the tool's state, with no file of its own | `app-data/` | `flock`, from `ensure`, `turn-off-private-rpc` and `undo-apply` | `flock` |
| `ensure`'s log | `logs/ensure.log` | both `cron` lines | the operator |
| The tool's error log | `logs/error.log` | `apply`, when `nginx -t` refuses its configuration | the operator |
| `x1console`'s Telegram files | `telegram_token.txt` and `chat_id.txt` in `x1consoleDir` | `x1console` | `ensure`, the key count check, and `apply`'s test alert |
| The Cronitor url | `X1_PRIVATE_RPC_CRONITOR_URL` in the project's `.env` | the operator | `ensure` |
| The operator's settings | `app-config/user-configurable/private-rpc.json` | the operator | every command |
| The shipped settings and their schema | `private-rpc.json` and `private-rpc.schema.json` in `app-config/app-defaults-for-user-configurable/` | shipped with the tool | every command |
| nginx.org's signing keys, `apt` source and `apt` pin | `/etc/apt/keyrings/nginx-archive-keyring.gpg`, `/etc/apt/sources.list.d/nginx.sources`, `/etc/apt/preferences.d/99nginx` | `apply`, each only when it's missing, and the keys and the source only when no other `apt` entry names nginx.org's repository | `apt` |
| Let's Encrypt's staging roots | `certs/letsencrypt-staging-roots.pem` | shipped with the tool | `apply` and `ensure`, after `--acme-staging` |
| The release, and the dns resolver | `/etc/os-release`, `/etc/resolv.conf` | Ubuntu | `apply`'s preflight |
| The `solana` cli's settings | `~/.config/solana/cli/config.yml` | the `solana` cli | `apply`'s preflight, which refuses a cli url that names this validator |
| The running validator's command line | `/proc/<pid>/cmdline`, for the process on the rpc port | the kernel | `apply`'s hand-over, `ensure`, and `turn-off-private-rpc` and `undo-apply` once they've taken the flag out, which check it for the flag |
| `git`'s lock in `x1console`'s checkout | `.git/index.lock` in `x1consoleDir` | `git`, during an update | `ensure`, which leaves the start script alone while it's there |

`app-data/`, `tmp/` and `logs/` sit in the feature's folder, and `git` ignores them. [`examples/`](../examples/README.md) holds what `apply` writes for the placeholder hostname and address, and a test checks each example against the tool's own output.

The api keys' file has this form, mode 0600 in a folder of mode 0700, and is written whole to a new file that then replaces the old one:

```json
{
  "version": 1,
  "kdf": "pbkdf2",
  "kdfParams": { "digest": "sha512", "iterations": 600000, "saltHex": "…" },
  "cipher": "aes-256-gcm",
  "passwordCheck": "IV.TAG.CIPHERTEXT",
  "hashedApiKeys": {
    "SHA-256 OF A KEY, IN HEX": {
      "createdAtTimestampMS": "IV.TAG.CIPHERTEXT",
      "email": "IV.TAG.CIPHERTEXT"
    }
  }
}
```

The file has one salt, so one opening derives one encryption key, from the password, which opens every record. Each encrypted value has its own iv, and is one string: the iv, GCM's tag and the ciphertext, in base64url, joined by dots. Its plain text is the value's json, so `createdAtTimestampMS` stays a number and `email` a string, `""` when none was given. `passwordCheck` holds a known text, encrypted the same way, so a typed password can be checked even when the file holds no record.

---

## Dependencies

The tool works through the system programs and files below, on the validator. The README's [System Programs](../README.md#system-programs) says which systems have them. The tool's Node.js packages are the runtime dependencies in the root `package.json`.

| Program or file | What the tool does with it |
| --- | --- |
| Node.js | `x1console`'s Node.js 20.0.0 runs `apply`. `apply` names that Node.js in the `cron` lines and the `git` hook, so it also runs their `ensure` and key count check. |
| `nginx`, with its njs and ACME modules | Serves the keyed url. Its njs module hashes each request's key, under QuickJS, and its map looks the hash up in `nginx`'s list. Its ACME module gets and renews the certificate from Let's Encrypt. `apply` installs `nginx` from nginx.org, and has `nginx -t` test the configuration before stage five starts, restarts or reloads `nginx`. |
| `systemd` | Runs `nginx` as `nginx.service`, with a drop-in that starts it with the tool's configuration and its own read-only `/dev`, after making its log folder when it's missing. `systemctl` masks and unmasks, enables, starts, reloads, restarts, stops and disables `nginx`, reloads `systemd` after the drop-in changes, and reads `nginx`'s state. |
| `systemd`'s encrypted credentials | `systemd-creds` saves the password, tied to the machine's TPM2 chip when there is one, and `systemd-analyze` or `systemd-creds` says whether there is. |
| `/etc/resolv.conf` | Names the system's dns resolver, which on Ubuntu is `systemd-resolved`, at 127.0.0.53. `nginx` asks it for Let's Encrypt's address. |
| `apt` and `dpkg` | `apt` refreshes its package lists, and installs `nginx` and its two modules from nginx.org's repository. `undo-apply` never removes them. The upgrade check installs nginx.org's previous release of them, upgrades it, and purges what it installed. `dpkg` unpacks each package, and `dpkg-query` says which version is installed. |
| `/etc/os-release` | Says the system is Ubuntu, and which release. The release's name, such as `noble`, picks nginx.org's packages. |
| `ufw` | Opens tcp port 443, lists its rules, even while `ufw` is off, and deletes the rule for `undo-apply`. |
| `gpg` | Checks that nginx.org's key file holds the two keys the tool pins, and puts only those into the keyring `apt` trusts. `gpgconf` stops `gpg`'s helpers afterwards. |
| `cron` and `flock` | `cron` runs `ensure` every minute, and the key count check every `apiKeyCountCheckHours` hours, from the lines `apply` adds with `crontab`. `flock` skips a run of `ensure` while the last one is still going. It also takes the api keys' lock, on the folder of their file, and the command holds it while it changes the keys. And it takes the start script's lock, on the folder of the tool's state, for `ensure`, `turn-off-private-rpc` and `undo-apply`'s step that takes the flag out. |
| `logrotate` | nginx.org's rule for it rotates `nginx`'s logs every day, keeps 52 days of them, and has `nginx` reopen them. The tool adds no rule of its own. |
| `ss` | Finds what listens on a port, and so finds the validator by its rpc port. |
| `/proc` | Holds the running validator's command line. [Files the Tool Reads and Writes](#files-the-tool-reads-and-writes) says who reads it. |
| `git` | Runs the tool's hook in `x1console`'s checkout, after Update X1 Console pulls new commits. |
| `sudo` | Runs every step that needs root. |
| `whiptail` | Draws the disclaimer's dialog, which each run that can change the system shows first. |
| `getent` and `userdel` | `getent` tells whether the `nginx` account exists. `userdel` removes it when nginx.org's package made it, for the upgrade check, and for `undo-apply` once `nginx` is gone. |
| `sh`, `install`, `rm`, `grep` and the like | Handle files and folders, root's through `sudo`. |

---

## Integration with `x1console`

The tool meets `x1console` in three places, all in `x1console`'s checkout, which the `x1consoleDir` setting names: `~/x1console`. The architecture's [`x1console`'s Updates and Autopilot's Restarts](architecture.md#x1consoles-updates-and-autopilots-restarts) explains the short windows they leave.

### The Start Script

`x1console` starts the validator, and restarts it, through `start_validator.sh`, which the `startScriptFile` setting names. It holds one long `tachyon-validator` command, one flag per line.

`x1console` also ships `exstart_validator.sh`, an older start script aimed at X1's testnet. Nothing in `x1console` runs it: every start and restart, Autopilot's included, goes through `start_validator.sh`. So the tool leaves it alone. A validator started from it by hand would have a public rpc, and `ensure` would send its alert that the rpc is public within a minute.

- `apply` adds one word, `--private-rpc`, to the line that sets the rpc port, such as `--rpc-port 8899 \`. It first makes a timestamped backup beside the script. The validator takes the flag at its next start.
- The tool refuses three layouts rather than guess at them: no line that runs `tachyon-validator`, an rpc bound to an address other than 127.0.0.1, or a port line that isn't there exactly once.
- `turn-off-private-rpc` takes the word out, and `turn-on-private-rpc` puts it back. Each records the choice, which `ensure` follows.
- `undo-apply` takes back just that word, and removes its backups. It never copies an old backup over a newer `x1console` file.
- `apply`, `ensure`, `turn-off-private-rpc` and `undo-apply` read the running validator's own command line, from `/proc`, for the process on the rpc port, to tell whether it runs with the flag.

### The `git` Hook

Update X1 Console runs `git stash`, which takes the flag out, then `git pull`.

- `apply` writes the tool's hook, `.git/hooks/post-merge`, unless another program's hook is there. `git` runs it after a pull that brings new commits.
- The hook runs `ensure --quiet --from-git-hook`, which puts the flag back before the update finishes. It always exits 0, so it can't fail the update.
- After a pull that brings nothing new, `git` runs no hook. The `cron` job's `ensure` puts the flag back within a minute after `startScriptQuietSeconds` has passed.
- Every run of `ensure` but the hook's waits out an update. It leaves the script alone while `.git/index.lock` exists, or while the script changed less than `startScriptQuietSeconds` ago. An edit between the stash and the end of the pull could make the pull fail, when the update changes the start script.
- The hook and the `cron` lines name `x1console`'s Node.js 20.0.0 by its full path.
- `undo-apply` removes the hook while it's still the tool's.

### The Telegram Set-up

`x1console` keeps its Telegram bot's token and chat id in `telegram_token.txt` and `chat_id.txt`, in its checkout.

- The tool reads both files in place and keeps no copy, and the x1-validator-services password doesn't lock them. The architecture's [Security Model](architecture.md#security-model) says why.
- `ensure` and the key count check send their alerts through that bot, as plain text. `apply` sends a test alert when the files are there.
- With either file missing or empty, alerts are off. Each alert then goes to the log alone, ending `(alerts are off: x1console's Telegram files are missing)`.

---

## ensure's Checks and Alerts

`ensure` runs seven checks. Each reports ok, problem or unknown, with a line saying what it found:

| Check | Problem when |
| --- | --- |
| `flag-in-script` | The start script lacks the flag |
| `flag-running` | The process on the rpc port runs without the flag |
| `rpc-private` | The rpc or its websocket listens on an address other than 127.0.0.1 |
| `nginx-active` | `systemd` doesn't report `nginx` as active |
| `nginx-listens` | Anything but the public address's port 443 listens on port 80 or 443, or nothing listens there |
| `gate` | Never: an answer other than ok is unknown, since the `nginx` and certificate checks say why |
| `certificate` | The certificate can't be read over tls, is for another name, or has fewer than `certificateWarningDays` left |

Every problem sets `ensure`'s exit code. An unknown verdict, such as the certificate's while `nginx` is down, keeps the check's last alert state, so one outage doesn't alert twice. Which checks alert, with each alert's wording and how often it repeats, is in the README's [Alerts](../README.md#alerts) section.

The process on the rpc port is found by that port, never by a name pattern, which could match another process.

`ensure` never counts keys. The key count check does, apart, with `countMapLines` from `src/lib/key-hash-map.js`, as the commands that write `nginx`'s list count what they wrote. While the list holds no key, it alerts on every run, with no alert state, and exits 1.

---

## `nginx`'s Configuration and the Key Check

`renderNginxConfig` writes one `http` block with one `server`, on the public address's port 443 alone:

- One worker process, at a lower priority than the validator, `nginxWorkerPriority`.
- `worker_shutdown_timeout 10s`: 10 seconds after a reload, the old worker closes what it still holds, websockets included. [The Keys' Path](architecture.md#the-keys-path) says why.
- `client_header_timeout 5s`: a connection has 5 seconds from its opening to finish its tls handshake and send its request's header, and each later request on a kept-alive connection has 5 seconds of its own. [The Request Path](architecture.md#the-request-path) says why.
- The ACME module's issuer, Let's Encrypt, with the tls-alpn-01 challenge. With `--acme-staging`, a second issuer, Let's Encrypt's staging service, serves the certificate instead.
- `js_engine qjs` runs the key check under QuickJS. `js_set` runs its `keyHash` and `forwardPath` for every request, and its `loggedUri` for each line of the access log.
- A `map` looks `keyHash`'s answer up in `nginx`'s list, which it includes. `map_hash_bucket_size` and `map_hash_max_size` are set as `src/lib/key-hash-map.js` says, so the table builds at once for every key the tool allows, as [Technology Choices](architecture.md#technology-choices) measures. A request whose hash isn't in the list gets 403.
- `limit_req` gives every keyed request one shared budget: `rateLimitRequestsPerSecond` a second, plus a burst of as many more at once. A request without a listed key never reaches it, since it gets its 403 first, in `nginx`'s rewrite phase.
- Keyed requests go to the rpc port on 127.0.0.1, or to the next port, the websocket's, when they ask for an upgrade.
- The access log's format writes the url as `loggedUri` gives it: `<key>` in place of every run of hex digits at least half a key long, in either case, anywhere in the url. An `nginx` `map` could replace only one run per url, so the key check's `loggedUri` does the replacing. The format's other fields carry no key: the time, the client's address, the method, the status, the bytes sent and the duration. The server's `access_log` line names this format, `x1_rpc`, and the keyed location inherits it. An `access_log` line that named no format would get `nginx`'s own, which writes the request line, key and all. The gate page's access log is off. So no key reaches the log: not one in the query string, as some providers' urls carry it, nor one after a prefix, sent twice, or mistyped.
- The main error log, `/var/log/nginx/error.log`, keeps notice and above, and the keyed location writes no error log, so neither holds a key, as [The Request Path](architecture.md#the-request-path) explains.
- Request bodies of at most 10 KB, held in memory, and no response ever written to a temporary file.

The key check, `src/njs/x1-validator-private-rpc.js`, hashes the key at the start of the request's path with njs's own `crypto` module. It does so when that's a key of the right form, followed by a slash or nothing, and gives '' otherwise. Because `nginx` loads that file on its own, it keeps its own copy of the key's pattern. Its test holds the copy to `src/lib/api-key.js`, and its hash to `src/lib/key-hash-map.js`'s.

---

## The `nginx` Upgrade Check

`util/validate-nginx-upgrade/index.js` is the first install step. It proves, on the validator itself, that an `apt` upgrade of `nginx` keeps the keyed url working. The package's binary upgrade must hand over from the old `nginx` process to the new one, with `systemd` following. The new process must still check keys against the list.

It installs nginx.org's previous release, and a short-lived configuration of its own. That configuration listens on 127.0.0.1 alone, and checks keys as the real one does: the key check runs under QuickJS, with a map sized as the real one is, whose list holds a throwaway key's hash. In place of the rpc, it answers a listed key with ok. The check has `nginx -t` test it, so a mistake there shows `nginx`'s own reason. Then it starts `nginx` the way `apply` will, through the same drop-in, and upgrades it with `apt`. Before the upgrade and after it, the gate page must say ok, a request with the throwaway key must get 200, and one with a random key 403. It also checks that `systemd` followed the new main process without restarting it, and that the old process exited. The throwaway key exists only in the check's memory.

Every change it makes is pushed onto an undo list, with the command that undoes it by hand. The undo list runs newest first, even after a failure or a Ctrl-C, and prints the by-hand command of any undo step that fails. `judge.js` holds its decisions, as pure functions, and `terminal.js` its output and its spinner.

It shares its repository, `apt`, `systemd` and rendering code with `apply`, from `src/lib/`, so it tests the same code `apply` runs.

---

## The Rpc Check

`util/check-my-private-rpc/index.js` tries the keyed url from outside, as a client would. It asks for the hostname, shown as it's typed, then for the key, through the same hidden prompt the commands use for the password. Before any query, `inputProblem` holds the hostname to the schema's pattern and the key to its form in `src/lib/api-key.js`.

`sendQueries`, in `check.js`, then posts `checkQueryCount` json-rpc `getSlot` queries to `https://<hostname>/<key>`, one after another, each with `requestTimeoutSeconds` to answer. Each answer is a slot, or one of these: `nginx`'s 403, 429, 502, 503 or 504, another http status, an rpc error, or something that isn't json-rpc. A request can also fail on dns, the connection or the certificate. `judge` lets the first failure explain the verdict, and `table.js` draws the report. The check never prints the key, only its last four characters. Its first line and the report mask it. Its refusal of an answer that isn't a hostname doesn't quote the answer, which could be a pasted url.

---

## Tests

The feature's tests are in `test/`. Every effect goes through a stand-in host, except in the host's own tests, which run the real host in a temporary folder, with a stand-in for `sudo`. So no unit test touches the machine's own files:

- `helpers/fake-host.js`: the generic stand-in. Commands go to an answer function the test writes, files live in a map, and every call is recorded in order.
- `helpers/fake-validator.js`: a machine for the upgrade check, whose `apt`, `systemd` and `nginx` change a small state. Its test `nginx` answers a key whose hash a list it was given holds.
- `helpers/fake-x1-validator.js`: a stock `x1console` validator for `apply`, `ensure`, `undo-apply` and the key commands. It has an executable start script and a `git` checkout, where the settings put them, and a running validator. It also has `ufw`, on or off, and `cron`, whose table holds one of Autopilot's jobs. Its `nginx` reads the list of hashes where the settings put it, at each start and reload, and answers a key whose hash it read.
- `helpers/applied-validator.js`: that validator once `apply` has run on it, for the commands that come after.
- `helpers/scripted-prompts.js`: answers to confirmations, choices, lines such as an email, and passwords.
- `helpers/config-copies.js`: temporary copies of `app-config/`, so no test reads the operator's settings. One kind of copy changes every setting from its shipped value, so a test can prove the configured value is the one used. `wrongPaths` reads the fake host's record of a command's calls, and the texts of the files the command wrote. It names each path setting whose shipped path appears in either, or whose changed path no call used.
- `helpers/fake-sudo.js`: a stand-in for `sudo`, for the host's own tests.
- `helpers/rpc-standin.js`: a stand-in for the validator's rpc, for the system test.
- `helpers/reload-probe.js`: for the system test, holds each kind of connection open with a key while that key is removed.
- `fixtures/start_validator.sh`: a start script in `x1console`'s shape.
- `fixtures/crontab`: one of Autopilot's jobs, as `x1console`'s `setautopilot.sh` writes it, which `apply` and `undo-apply` must keep.

The end-to-end test, `npm run test:system`, runs the upgrade check, then `apply` and every command after it, in an LXD container. [`docs/engineering.md`](../../docs/engineering.md#the-system-test) describes it.

---

## Security

How the keys and the password are kept is in the README's [Api Key Security](../README.md#api-key-security) section. The security checks the gate runs, and every exception to them, are in [`docs/security.md`](../../docs/security.md).
