# X1 Validator Services — `npm` Project Commands

Every command defined in `package.json`, what it does, and what to type. Run each one from the project root.

Companion to [`docs/engineering.md`](engineering.md), which covers how the gate and the scripts work. This file covers how to drive them.

The programs the features ship, such as x1-validator-private-rpc's commands and its nginx upgrade check, aren't npm commands. The feature's README covers them, in [Run](../x1-validator-private-rpc/README.md#run) and [Install](../x1-validator-private-rpc/README.md#install).

---

## Table of Contents

- [Passing Flags](#passing-flags)
- [Getting Help on Any Command](#getting-help-on-any-command)
- [Developer Tools](#developer-tools)
- [Test](#test)
- [Commands That Are Usually Not Run Alone](#commands-that-are-usually-not-run-alone)
- [See Also](#see-also)

---

## Passing Flags

Run a command with `npm run <name>`. `test` also works without `run`. Flags for the script go after a `--` separator:

```sh
npm run test:system -- --keep
```

The `--` is what tells npm that the rest belongs to the script rather than to npm itself. Without it, `npm run test:system --keep` sets an npm setting, and the script never sees the flag.

---

## Getting Help on Any Command

Every command that runs one of the project's scripts also takes `--help`, or `-h`. It prints the script's flags and exit codes, and exits without doing anything:

```sh
npm run check -- --help
npm run lint -- --help
npm test -- --help
npm run test:system -- --help
```

The help is made from the flags each script declares, so the two can't drift apart. `knip:files`, `audit:deps` and `audit:deps:all` run knip or npm itself, so `--help` shows that tool's own help instead.

---

## Developer Tools

Formatting and the code checks a change is written against.

| Command | Flags | Description | Example |
| ------- | ----- | ----------- | ------- |
| `format` | — | Prettier rewrites every JavaScript file it would change. Run it when the lint or the gate reports unformatted JavaScript. For json or yaml, run `lint:fix`. | `npm run format` |
| `knip:files` | — | Lists every file nothing imports. The gate fails on any. | `npm run knip:files` |
| `lint` | — | Every lint, format, dead-code and security check that needs nothing but this machine, with a summary. The pre-commit hook runs it. Needs Node.js 22.13 or newer. | `npm run lint` |
| `lint:fix` | — | The same checks, with each tool rewriting what it can fix. | `npm run lint:fix` |

---

## Test

The gates. `check` runs all of them but the system test, and must pass before every commit and every push.

| Command | Flags | Description | Example |
| ------- | ----- | ----------- | ------- |
| `audit:deps` | — | `npm audit` over the dependencies that ship, failing on a high or critical advisory. The gate runs it. | `npm run audit:deps` |
| `audit:deps:all` | — | The same audit over every dependency, development tools included. The gate saves this report, and doesn't fail on it. | `npm run audit:deps:all` |
| `audit:secrets` | — | secretlint, for credentials committed by mistake. | `npm run audit:secrets` |
| `audit:security` | — | The security lint, `eslint-security.config.js`. | `npm run audit:security` |
| `check` | — | The full gate, with a summary. On Node.js 22.13 or newer it runs every lint, format, security and dead-code check, the audits, the tests and the coverage verdict. On Node.js 20.0.0 it runs the features' tests alone. See [The Gate](engineering.md#the-gate). | `npm run check` |
| `format:check` | — | Prettier in check mode: lists the JavaScript files it would change, and changes none. | `npm run format:check` |
| `test` | — | Every test once, for quick runs while working. Only `check` counts before a commit. | `npm test` |
| `test:coverage` | — | Every test once, with a coverage summary. | `npm run test:coverage` |
| `test:system` | `--keep` | x1-validator-private-rpc end to end, in a throwaway LXD container, never on a validator. Not part of `check`. `--keep` leaves the container for a look inside. Its feature's README says what it needs, in [Test](../x1-validator-private-rpc/README.md#test). | `npm run test:system` · `npm run test:system -- --keep` |
| `test:watch` | — | Runs the tests again on every change. | `npm run test:watch` |

---

## Commands That Are Usually Not Run Alone

npm runs these on its own.

| Command | Flags | Description | Example |
| ------- | ----- | ----------- | ------- |
| `prepare` | — | Runs after `npm install` or `npm ci`, and installs the pre-commit hook, which runs `npm run lint`. On a validator, `npm ci --ignore-scripts` skips it, since the hook is a development tool. | automatic |

---

## See Also

- [`docs/engineering.md`](engineering.md): how the gate, the tests and the system test work.
- [x1-validator-private-rpc's README](../x1-validator-private-rpc/README.md): the feature's own commands, which aren't npm commands.
- [`CLAUDE.md`](../CLAUDE.md): the conventions every change follows.
- [`docs/security.md`](security.md): the security checks' exceptions, and the dependency overrides.
