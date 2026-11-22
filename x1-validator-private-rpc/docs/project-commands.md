# x1-validator-private-rpc — Commands

Every command of x1-validator-private-rpc, what it does, and what to type.

x1-validator-private-rpc is a command-line tool that you run on an X1 validator set up by `x1console`. It makes the validator's rpc private, and puts it behind an https url that carries an api key, such as `https://x1-rpc.example.com/KEY`: the keyed url.

This file lists every command and every option. Start with the feature's [README](../README.md): it covers installing the tool and using it, with an example of each common command. How the tool works is in [`architecture.md`](architecture.md) and [`engineering.md`](engineering.md).

---

## Table of Contents

- [Running a Command](#running-a-command)
- [Getting Help on Any Command](#getting-help-on-any-command)
- [The Tool's Commands](#the-tools-commands)
- [The Standalone Tools](#the-standalone-tools)

---

## Running a Command

Run each command as the validator's account, from the project's folder, `~/x1-validator-services`. The tool needs Node.js 24 or newer. A validator's default `node`, the one a bare `node` starts, is Node.js 20.0.0, which `x1console` installed, and it's too old for the tool. `x1console` installs Node.js with `nvm`, the Node.js version manager, which holds several versions side by side. The project's [Get the Code](../../README.md#get-the-code) step adds Node.js 24 beside it, and `nvm exec 24` runs one command on Node.js 24. So every command starts with it:

```bash
cd ~/x1-validator-services
nvm exec 24 node x1-validator-private-rpc/src/cli.js url
```

A command's options go after its name, as in `apply --dry-run`.

To type the tool's name instead, from any folder, link its launcher into `~/.local/bin`, as the README's [Usage](../README.md#usage) shows. The launcher, `x1-validator-private-rpc/bin/x1-validator-private-rpc`, is a small script that runs the tool on the newest Node.js 24 that `nvm` holds. Then `x1-validator-private-rpc url` does the same as the command above.

Before a run that can change the system, the tool shows its disclaimer, and goes on only once you affirm it. The README's [Disclaimer](../README.md#disclaimer) says which runs show it.

---

## Getting Help on Any Command

The tool, each of its commands, and the two standalone tools below take `--help`, or `-h`. It prints what the command does, every option it takes, an example of each common use, and what each exit code means, and exits without doing anything else:

```bash
nvm exec 24 node x1-validator-private-rpc/src/cli.js --help
nvm exec 24 node x1-validator-private-rpc/src/cli.js apply --help
nvm exec 24 node x1-validator-private-rpc/util/check-my-private-rpc/index.js --help
```

The tool's own help also lists its commands. Its `--version`, or `-v`, prints the project's version.

---

## The Tool's Commands

`apply` sets the tool up. The other commands keep the rpc private, manage the api keys, turn private rpc off and on, and take back what `apply` changed. Each example runs from the project's folder.

| Command | Options | Description | Example |
| ------- | ------- | ----------- | ------- |
| `apply` | `--dry-run`, `--acme-staging`, `--yes`/`-y` | Sets the tool up, in stages, and asks before each one that changes something. It installs `nginx` from nginx.org in front of the rpc, with a certificate from Let's Encrypt, makes the first api key, and adds `--private-rpc` to `x1console`'s start script, which keeps the rpc on 127.0.0.1 from the validator's next start. Last, it installs the tool's `git` hook, and offers two `cron` jobs, which run `ensure` and the key count check below. Run it to install the tool, after each update of the tool, and after you change a setting. A run changes nothing that's already in place, so after a stop, the next run picks up where it left off. `--dry-run` prints every change it would make, and makes none. `--acme-staging` gets the certificate from Let's Encrypt's staging service, for the first run: Let's Encrypt allows only five failed requests an hour for one hostname, and failures at the staging service don't count. `--yes` answers yes to each stage's question and to the `cron` jobs' question. You still type the x1-validator-services password, which encrypts the api keys' records, and answer whether to save it. [Run apply](../README.md#run-apply) says more. | `nvm exec 24 node x1-validator-private-rpc/src/cli.js apply --dry-run` · `nvm exec 24 node x1-validator-private-rpc/src/cli.js apply --acme-staging` · `nvm exec 24 node x1-validator-private-rpc/src/cli.js apply` |
| `ensure` | `--quiet`/`-q`, `--from-git-hook` | Keeps the rpc private, and alerts you on Telegram when something is wrong. An `x1console` update takes `--private-rpc` out of the start script, and `ensure` puts it back. It also checks that the rpc listens only on 127.0.0.1, that `nginx` runs, and that `nginx`'s certificate is for your hostname with more than `certificateWarningDays` left. The tool's `git` hook runs it when an update's `git pull` brings new commits, and the `cron` job, if you accepted it, runs it every minute. Run it yourself before you choose Update X1 Validator, which restarts the validator, and check that it says the start script carries `--private-rpc`. `--quiet`, which the `cron` job passes, prints only what changed and the alerts sent. `--from-git-hook` is for the `git` hook: it puts the flag back at once, since `git` runs the hook only once the update's merge is done. [After an `x1console` Update](../README.md#after-an-x1console-update) says more. | `nvm exec 24 node x1-validator-private-rpc/src/cli.js ensure` · `nvm exec 24 node x1-validator-private-rpc/src/cli.js ensure --quiet` |
| `add-api-key` | `--count <n>` | Makes api keys, such as one for a new client. First it checks that the `maxApiKeys` setting leaves room for them. Then it asks for the x1-validator-services password, which encrypts each key's record, and for an optional email. A key's record holds when the key was made, and the email, which is the same for every key of one run. Then it makes the keys, prints each key's https and wss urls, and reloads `nginx` so that it accepts them. Printing the urls is the only time the tool shows a key, since it stores only the key's hash. Save the urls then: the client needs them, and you need the key to remove it later. `--count <n>` makes n keys in one run, 1 if left out. [Api Keys](../README.md#api-keys) says more. | `nvm exec 24 node x1-validator-private-rpc/src/cli.js add-api-key` · `nvm exec 24 node x1-validator-private-rpc/src/cli.js add-api-key --count 3` |
| `remove-api-key` | — | Removes an api key, such as one that leaked, so that `nginx` refuses it. It asks for the key, which you paste at a prompt that shows nothing, and asks for no password. Removing the last key asks first, since `nginx` then refuses every request. Then it reloads `nginx`. If it stops part way, run it again with the same key, as [Api Keys](../README.md#api-keys) explains. | `nvm exec 24 node x1-validator-private-rpc/src/cli.js remove-api-key` |
| `url` | — | Prints the keyed url's two forms, https and wss, with `KEY` in place of the key, and how many api keys `nginx`'s list holds. It changes nothing. Use it when you need the url's form again, such as when you hold a key but not its urls, since no command shows a key twice. | `nvm exec 24 node x1-validator-private-rpc/src/cli.js url` |
| `ensure-there-is-at-least-one-rpc-api-key` | `--quiet`/`-q` | The key count check. While `nginx`'s list of the api keys' hashes is empty, as after `remove-api-key` takes the last key, `nginx` refuses every request. This command checks that the list holds a key, and sends an alert on Telegram when it doesn't. The second `cron` job that `apply` offers runs it every `apiKeyCountCheckHours` hours. `--quiet`, which that `cron` job passes, prints only the alert, when there is one. | `nvm exec 24 node x1-validator-private-rpc/src/cli.js ensure-there-is-at-least-one-rpc-api-key` · `nvm exec 24 node x1-validator-private-rpc/src/cli.js ensure-there-is-at-least-one-rpc-api-key --quiet` |
| `turn-off-private-rpc` | `--yes`/`-y` | Makes the rpc public again without uninstalling the tool. It asks, then takes `--private-rpc` out of the start script, and records the choice, so that `ensure` stops putting the flag back. The rpc listens on every interface again from the validator's next start. Everything else stays: `nginx` keeps serving the keyed url. `--yes` skips the question. [Turn the Private Rpc Off and On](../README.md#turn-the-private-rpc-off-and-on) says more. | `nvm exec 24 node x1-validator-private-rpc/src/cli.js turn-off-private-rpc` |
| `turn-on-private-rpc` | — | Makes the rpc private again after `turn-off-private-rpc`. It puts `--private-rpc` back into the start script, and records the choice, so that `ensure` again puts the flag back after each `x1console` update. The rpc listens only on 127.0.0.1 from the validator's next start. | `nvm exec 24 node x1-validator-private-rpc/src/cli.js turn-on-private-rpc` |
| `undo-apply` | `--dry-run` | Uninstalls the tool. `apply` records each change it makes on the machine, and `undo-apply` takes back those changes, newest first. What was there before `apply` stays. It leaves `nginx` installed, since something else may need it, and says how to remove it. First it asks whether to delete every api key, and the saved password with them: a no keeps both, so that a later `apply` hands `nginx` the same keys. `--dry-run` prints every step, and takes none. [Uninstall](../README.md#uninstall) says more. | `nvm exec 24 node x1-validator-private-rpc/src/cli.js undo-apply --dry-run` · `nvm exec 24 node x1-validator-private-rpc/src/cli.js undo-apply` |

---

## The Standalone Tools

Two tools come with x1-validator-private-rpc, apart from its commands. Each is a script of its own, which you start with `nvm exec 24 node` and the script's path, from the project's folder.

| Tool | Options | Description | Example |
| ---- | ------- | ----------- | ------- |
| `validate-nginx-upgrade` | — | Once the tool is installed, `nginx` updates with the system's other packages, so an `apt` upgrade of `nginx` must keep the keyed url working. This check proves that on this machine. Run it once, as the first install step, before `apply`. It installs nginx.org's previous release, with a throwaway api key, and upgrades it with `apt`. Then it checks that `systemd` still counts `nginx` as running, now as the new process, and that the new `nginx` still lets the throwaway key through and turns a random one away. Last, it removes everything it added. It takes a few minutes, so run it inside `tmux`, where a dropped `ssh` connection can't stop it halfway. [Check That `nginx` Upgrades Keep Working](../README.md#check-that-nginx-upgrades-keep-working) says more. | `nvm exec 24 node x1-validator-private-rpc/util/validate-nginx-upgrade/index.js` |
| `check-my-private-rpc` | — | Checks once that your keyed url works for a client, such as after the validator's restart, or when a client reports a problem. It asks for the rpc's hostname and an api key, without showing the key, sends the rpc a run of queries through `nginx`, and prints a table of the answers. It runs on the validator, or on any machine where the project is installed. On a machine without `nvm`, start it with a `node` that's Node.js 24 or newer, in place of `nvm exec 24 node`. [Check](../README.md#check) says more. | `nvm exec 24 node x1-validator-private-rpc/util/check-my-private-rpc/index.js` |
