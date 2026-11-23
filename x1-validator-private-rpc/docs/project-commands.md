# x1-validator-private-rpc — Commands

Every command of x1-validator-private-rpc, what it does, and what to type.

x1-validator-private-rpc is a command-line tool that you run on an X1 validator set up by `x1console`. It makes the validator's rpc private, and puts it behind `nginx`, on an https url that carries an api key, such as `https://x1-rpc.example.com/KEY`: the keyed url.

Start with the feature's [README](../README.md): it covers installing the tool and using it, with an example of each common command. Besides the commands, this file lists every option, and the two standalone tools that come with the tool, programs of their own. `validate-nginx-upgrade`, which you run once, as the first install step, proves on this machine that an `apt` upgrade of `nginx` keeps a keyed url working. `check-my-private-rpc` checks that your keyed url works for a client, such as after the validator's restart. [The Standalone Tools](#the-standalone-tools) describes both. How the tool works is in [`architecture.md`](architecture.md) and [`engineering.md`](engineering.md).

---

## Table of Contents

- [Running a Command](#running-a-command)
- [Getting Help on Any Command](#getting-help-on-any-command)
- [The Tool's Commands](#the-tools-commands)
- [The Standalone Tools](#the-standalone-tools)

---

## Running a Command

Run each command as the validator's account, from the project's folder, `~/x1-validator-services`. The tool needs Node.js 24 or newer. `x1console` installs `nvm`, the Node.js version manager, and through it Node.js 20.0.0, which `x1console`'s own scripts run on. That's the validator's default `node`, the one a bare `node` starts, and it's too old for the tool. `nvm` holds several versions side by side, and the project's [Get the Code](../../README.md#get-the-code) step adds Node.js 24 beside 20.0.0. `nvm exec 24` runs one command on Node.js 24, so every command starts with it. The example below runs `url`, which prints the keyed url's two forms, https and wss, and changes nothing:

```bash
cd ~/x1-validator-services
nvm exec 24 node x1-validator-private-rpc/src/cli.js url
```

A command's options go after its name, as in `apply --dry-run`: `apply` sets the tool up, and `--dry-run` makes it print every change it would make, and make none.

The tool also has a launcher, `x1-validator-private-rpc/bin/x1-validator-private-rpc`, a small script that runs the tool on the newest Node.js 24 that `nvm` holds. To type the tool's name instead, from any folder, link the launcher into `~/.local/bin`, as the README's [Run](../README.md#run) section shows. Then `x1-validator-private-rpc url` does the same as the command above.

Before a run that can change the system, the tool shows its disclaimer, and goes on only once you affirm it. The README's [Disclaimer](../README.md#disclaimer) says which runs show it.

---

## Getting Help on Any Command

The tool, each of its commands, and the two standalone tools below take `--help`, or `-h`. Given `--help`, each one prints what it does, every option it takes, an example of each common use, and what each exit code means, then exits without doing anything else:

```bash
nvm exec 24 node x1-validator-private-rpc/src/cli.js --help
nvm exec 24 node x1-validator-private-rpc/src/cli.js apply --help
nvm exec 24 node x1-validator-private-rpc/util/check-my-private-rpc/index.js --help
```

The tool's own help also lists its commands. Its `--version`, or `-v`, prints the project's version.

---

## The Tool's Commands

The commands other than `apply` keep the rpc private, manage the api keys, turn private rpc off and on, and take back what `apply` changed.

| Command | Options | Description | Example |
| ------- | ------- | ----------- | ------- |
| `apply` | `--dry-run`, `--acme-staging`, `--yes`/`-y` | Sets the tool up, in stages, and asks before each one that changes something. Run it to install the tool, after each update of the tool, and after you change a setting. It installs `nginx` from nginx.org in front of the rpc, with a certificate from Let's Encrypt. On a first install, it asks for a new x1-validator-services password, which encrypts the api keys' records. Then it makes the first api key, and asks whether to save the password. It adds `--private-rpc` to `x1console`'s start script: from the validator's next start, the flag makes the rpc listen on 127.0.0.1 alone. Last, it installs the tool's `git` hook, which runs `ensure` when an `x1console` update brings new commits. It also offers two `cron` jobs, which run `ensure` and the key count check, both below. A run changes nothing that's already in place, so after a stop, the next run with the same options picks up where it left off. `--dry-run` prints every change it would make, and makes none. `--acme-staging` gets the certificate from Let's Encrypt's staging service, for the first run: Let's Encrypt allows only five failed requests an hour for one hostname, and failures at the staging service don't count. No client trusts a staging certificate, but the staging service checks that the hostname is yours the same way as for a real certificate. `apply` waits for the certificate, and stops when none comes, so a staging run that finishes shows that Let's Encrypt can check your hostname. Then run `apply` again without the option, for the real certificate. `--yes` answers yes to each stage's question and to the `cron` jobs' question. You still affirm the disclaimer, type the password, and answer whether to save it. [Run apply](../README.md#run-apply) says more. | `nvm exec 24 node x1-validator-private-rpc/src/cli.js apply --dry-run` · `nvm exec 24 node x1-validator-private-rpc/src/cli.js apply --acme-staging` · `nvm exec 24 node x1-validator-private-rpc/src/cli.js apply` |
| `ensure` | `--quiet`/`-q`, `--from-git-hook` | Puts `--private-rpc` back into the start script after an `x1console` update takes it out. The tool's `git` hook runs `ensure` when an update's `git pull` brings new commits. If you accepted the `cron` job, that job runs `ensure` every minute. `ensure` leaves the script alone until the script has gone unchanged for `startScriptQuietSeconds`, since an edit during an update can make the update's `git pull` fail. `--from-git-hook`, which the `git` hook passes, has `ensure` put the flag back at once, without waiting for the script to go unchanged, since `git` runs the hook only once the update's merge is done. `ensure` also checks that the rpc listens only on 127.0.0.1, that `nginx` runs, and that `nginx`'s certificate is for your hostname with at least `certificateWarningDays` left. It alerts you on Telegram when one of these checks fails, when it puts the flag back, and when it can't. Run it yourself before you choose `x1console`'s Update X1 Validator, which restarts the validator, and check that it says the start script carries `--private-rpc`. If it says it left the script alone, run it again once the script has gone unchanged for `startScriptQuietSeconds`. `--quiet`, which the `cron` job passes, prints only what changed and its alerts. [After an `x1console` Update](../README.md#after-an-x1console-update) says more. | `nvm exec 24 node x1-validator-private-rpc/src/cli.js ensure` · `nvm exec 24 node x1-validator-private-rpc/src/cli.js ensure --quiet` |
| `add-api-key` | `--count <n>` | Makes api keys, such as one for a new client. First it checks that the `maxApiKeys` setting leaves room for them. Then it asks for the x1-validator-services password, which encrypts each key's record, and for an optional email, the client's. A key's record holds when the key was made, and the email, which is the same for every key of one run. Then it makes the keys, writes each key's hash and record to the api keys' file, `~/.config/x1-validator-services/hashed-api-keys.json`, and prints each key's https and wss urls. Printing the urls is the only time the tool shows a key, since it stores only the key's hash, which can't be turned back into the key. Save the urls as soon as they're printed: the client needs them, and you need the key to remove it later. After it prints the urls, it writes `nginx`'s list from the api keys' file, so the list holds the new keys' hashes. `nginx` checks each request against that list. Last, `add-api-key` reloads `nginx`, so that `nginx` accepts the new keys. `--count <n>` makes n keys in one run, 1 if left out. [Api Keys](../README.md#api-keys) says more. | `nvm exec 24 node x1-validator-private-rpc/src/cli.js add-api-key` · `nvm exec 24 node x1-validator-private-rpc/src/cli.js add-api-key --count 3` |
| `remove-api-key` | — | Removes an api key, such as one that leaked, so that `nginx` refuses it. It asks for the key, which you paste at a prompt that shows nothing. It asks for no x1-validator-services password: it hashes the key you paste, and looks for that hash in the api keys' file, where the hashes aren't encrypted. Removing the last key asks first, since `nginx` then refuses every request. It takes the key's hash out of `nginx`'s list, reloads `nginx`, and last takes the hash, with its record, out of the api keys' file. A stop before that last step leaves the hash in the api keys' file. `add-api-key`, `remove-api-key` for another key, and `apply` each write `nginx`'s list from that file, so each would put the hash back in the list, and the key would work again. So if it stops partway, run it again with the same key, before any of them. [Api Keys](../README.md#api-keys) says more. | `nvm exec 24 node x1-validator-private-rpc/src/cli.js remove-api-key` |
| `url` | — | Prints the keyed url's two forms, https and wss, with `KEY` in place of the key, and how many api keys `nginx`'s list holds. It changes nothing. Use it when you need the url's form again, such as when you hold a key but not its urls. No command can show a key again, so you put your key in place of `KEY` yourself. | `nvm exec 24 node x1-validator-private-rpc/src/cli.js url` |
| `ensure-there-is-at-least-one-rpc-api-key` | `--quiet`/`-q` | The key count check. While `nginx`'s list of the api keys' hashes is empty, as after `remove-api-key` removes the last key, `nginx` refuses every request. This command checks that the list holds at least one hash, and sends an alert on Telegram when it doesn't. The second `cron` job that `apply` offers runs it every `apiKeyCountCheckHours` hours. `--quiet`, which that `cron` job passes, prints only the alert, when there is one. | `nvm exec 24 node x1-validator-private-rpc/src/cli.js ensure-there-is-at-least-one-rpc-api-key` · `nvm exec 24 node x1-validator-private-rpc/src/cli.js ensure-there-is-at-least-one-rpc-api-key --quiet` |
| `turn-off-private-rpc` | `--yes`/`-y` | Makes the rpc public again without uninstalling the tool. It asks you to confirm, then takes `--private-rpc` out of the start script, and records the choice, so that `ensure` stops putting the flag back. The rpc listens on every interface again from the validator's next start. Everything else stays: `nginx` keeps serving the keyed url. A later `apply` turns private rpc on again. `--yes` skips the question. [Turn the Private Rpc Off and On](../README.md#turn-the-private-rpc-off-and-on) says more. | `nvm exec 24 node x1-validator-private-rpc/src/cli.js turn-off-private-rpc` |
| `turn-on-private-rpc` | — | Makes the rpc private again after `turn-off-private-rpc`. It puts `--private-rpc` back into the start script, and records the choice, so that `ensure` again puts the flag back after each `x1console` update. The rpc listens only on 127.0.0.1 from the validator's next start. | `nvm exec 24 node x1-validator-private-rpc/src/cli.js turn-on-private-rpc` |
| `undo-apply` | `--dry-run` | Uninstalls the tool. First it asks whether to delete every api key, with the saved password if `apply` saved one. Then it takes back the changes `apply` made on the machine, newest first. `apply` records each change as it happens. What was there before `apply` stays. `undo-apply` stops `nginx`, so every client's url stops working. `undo-apply` leaves `nginx` installed, since something else may need it, and prints the commands that remove `nginx`. After a no to the question, the keys and the saved password stay, so a later `apply` writes `nginx`'s list from the same keys' hashes, and every client's url works again. `--dry-run` prints every step, and takes none. [Uninstall](../README.md#uninstall) says more. | `nvm exec 24 node x1-validator-private-rpc/src/cli.js undo-apply --dry-run` · `nvm exec 24 node x1-validator-private-rpc/src/cli.js undo-apply` |

---

## The Standalone Tools

Each standalone tool is a script of its own, not a command of the tool. You start it with `nvm exec 24 node` and the script's path, from the project's folder.

| Tool | Options | Description | Example |
| ---- | ------- | ----------- | ------- |
| `validate-nginx-upgrade` | — | Once the tool is installed, `nginx` updates with the system's other packages, so an `apt` upgrade of `nginx` must keep a keyed url working. This check proves that on this machine. Run it once, as the first install step, before `apply`. It installs nginx.org's previous release of `nginx`, with a throwaway api key, then upgrades that `nginx` with `apt`. nginx.org's upgrade starts a new `nginx` process and hands over to it, without a restart. `systemd` tracks a service by its main process, so it must follow that handover. If it didn't, it would stop counting `nginx` as running, or restart `nginx`, which drops every open connection. The check makes sure that neither happened: `systemd` still counts `nginx` as running, now as the new process, with no restart. It also makes sure that the new `nginx` still lets the throwaway key through and turns a random one away. Last, it removes everything it added. It takes a few minutes, so run it inside `tmux`, where a dropped `ssh` connection can't stop it halfway and leave `nginx` installed. [Check That `nginx` Upgrades Keep Working](../README.md#check-that-nginx-upgrades-keep-working) says more. | `nvm exec 24 node x1-validator-private-rpc/util/validate-nginx-upgrade/index.js` |
| `check-my-private-rpc` | — | Checks once that your keyed url works for a client, such as after the validator's restart, or when a client reports a problem. It asks for the rpc's hostname and an api key, without showing the key, sends the rpc a run of queries through `nginx`, and prints a table of the answers. It runs on the validator, or on any machine where the project is installed. On a machine without `nvm`, start it with a `node` that's Node.js 24 or newer, in place of `nvm exec 24 node`. [Check](../README.md#check) says more. | `nvm exec 24 node x1-validator-private-rpc/util/check-my-private-rpc/index.js` |
