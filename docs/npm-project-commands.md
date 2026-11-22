# X1 Validator Services — `npm` Project Commands

Every command defined in `package.json`, what it does, and what to type. Run each one from the project root. Each needs Node.js 24 or newer, and runs on the two long-term-support majors the project supports, 24 and 26, as [Node.js Versions](engineering.md#nodejs-versions) explains.

Companion to [`docs/engineering.md`](engineering.md), which covers how the scripts and the gate work. The gate, `npm run check`, runs the checks that must pass before every commit. This file covers how to drive them.

The programs the features ship, such as x1-validator-private-rpc's commands and its `nginx` upgrade check, aren't `npm` commands. The feature's [`docs/project-commands.md`](../x1-validator-private-rpc/docs/project-commands.md) lists them, with their options.

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

Run a command with `npm run <name>`. `test` also works without `run`. Flags for the script go after a `--` separator. For example, `test:system` runs x1-validator-private-rpc end to end in a throwaway LXD container. Its `--keep` keeps the container after the test, so you can look inside:

```sh
npm run test:system -- --keep
```

The `--` is what tells `npm` that the rest belongs to the script rather than to `npm` itself. Without it, `npm run test:system --keep` sets an `npm` setting, and the script never sees the flag.

---

## Getting Help on Any Command

Every command runs one of the project's scripts, and takes `--help`, or `-h`. It prints the script's flags, an example of each common use, and its exit codes, and exits without doing anything:

```sh
npm run check -- --help
npm run lint -- --help
npm test -- --help
npm run test:system -- --help
```

The help is made from the flags each script declares, so the two can't drift apart.

---

## Developer Tools

Formatting and the code checks a change is written against.

| Command | Flags | Description | Example |
| ------- | ----- | ----------- | ------- |
| `format` | — | Prettier rewrites every JavaScript file it would change. Run it when the lint or the gate reports unformatted JavaScript. For json or yaml, run `lint:fix`. | `npm run format` |
| `knip:files` | — | Lists every JavaScript file nothing imports, which the gate fails on. It runs `knip`, through `scripts/check-unused-files.js`. Run it alone, such as after moving or deleting a file. | `npm run knip:files` |
| `lint` | — | The gate's lint, format, dead-code and security checks, without the tests and the dependency audits, with a summary. The pre-commit hook runs it. | `npm run lint` |
| `lint:fix` | — | The same checks, with each tool rewriting what it can fix. | `npm run lint:fix` |

---

## Test

The checks and tests. `check` runs all of them but the system test.

| Command | Flags | Description | Example |
| ------- | ----- | ----------- | ------- |
| `audit:deps` | — | `npm audit` over the dependencies that ship, failing on a high or critical advisory. The gate and the Security Audit workflow run it. | `npm run audit:deps` |
| `audit:deps:all` | — | The same audit over every dependency, development tools included. The gate saves this report, and doesn't fail on it. | `npm run audit:deps:all` |
| `audit:secrets` | — | `secretlint`, for credentials committed by mistake. | `npm run audit:secrets` |
| `audit:security` | — | ESLint with the security rules in `eslint-security.config.js`: they flag code patterns that often lead to a vulnerability, strings random enough to be keys, and `console` calls that pass a value named like a secret. | `npm run audit:security` |
| `check` | — | The full gate, with a summary. [The Gate](engineering.md#the-gate) says what it runs, and when it must pass. | `npm run check` |
| `format:check` | — | Prettier in check mode: lists the JavaScript files it would change, and changes none. | `npm run format:check` |
| `test` | — | Every test once, without the gate's other checks, for quick runs while working. Only `check` counts before a commit. | `npm test` |
| `test:coverage` | — | Every test once, with a coverage summary. | `npm run test:coverage` |
| `test:fuzzing` | — | Code-fuzzing: checks that the tests catch each feature's code-fuzzing changes, small changes to its code, made in memory, each paired with the test file that must fail when the change is made. It runs without the rest of the gate, such as after you add a change to a feature's list, `test/code-fuzzing.json`. `check` runs it last. [Code-Fuzzing](engineering.md#code-fuzzing) says more. | `npm run test:fuzzing` |
| `test:system` | `--keep` | x1-validator-private-rpc end to end, in a throwaway LXD container, never on a validator. Not part of `check`. `--keep` leaves the container for a look inside. Its feature's README says what it needs, in [Test](../x1-validator-private-rpc/README.md#test). | `npm run test:system` · `npm run test:system -- --keep` |
| `test:watch` | — | Runs the tests again on every change. | `npm run test:watch` |

---

## Commands That Are Usually Not Run Alone

`npm` runs these on its own.

| Command | Flags | Description | Example |
| ------- | ----- | ----------- | ------- |
| `prepare` | — | Runs after `npm install` or `npm ci`, and installs the pre-commit hook, which runs `npm run lint`. It runs `husky`, the package that installs `git` hooks, through `scripts/prepare.js`. Run it by hand only to set the hook up again. On a validator, `npm ci --ignore-scripts` skips it, since the hook is a development tool. | automatic · `npm run prepare` |

---

## See Also

- [`docs/engineering.md`](engineering.md): how the gate, the tests and the system test work.
- [x1-validator-private-rpc's README](../x1-validator-private-rpc/README.md): the feature's own commands, which aren't `npm` commands.
- [`CLAUDE.md`](../CLAUDE.md): the conventions every change follows.
- [`docs/security.md`](security.md): the security checks' exceptions, and the dependency overrides.
