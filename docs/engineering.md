# X1 Validator Services — Engineering Reference

This is the reference for the engineering every feature shares: the gate and each of its checks, the lists of files the checks read, the rules every test follows, the LXD system test, the scripts behind the npm commands, and CI.

Each feature's own design is in its folder. For x1-validator-private-rpc, read [`architecture.md`](../x1-validator-private-rpc/docs/architecture.md), then [`engineering.md`](../x1-validator-private-rpc/docs/engineering.md).

Other references:

- [`CLAUDE.md`](../CLAUDE.md): the conventions, where this project differs from LP Ranger's, and the repository's layout.
- [`docs/npm-project-commands.md`](npm-project-commands.md): every npm command, and what to type.
- [`docs/security.md`](security.md): the security checks' exceptions, and the dependency overrides.

---

## Table of Contents

- [`npm` Project Commands](#npm-project-commands)
- [The Gate](#the-gate)
  - [What It Runs](#what-it-runs)
  - [On Older Node.js Versions](#on-older-nodejs-versions)
  - [Reports](#reports)
- [File Lists](#file-lists)
- [Coverage](#coverage)
- [Dead Code](#dead-code)
- [Tests](#tests)
- [The System Test](#the-system-test)
- [The Scripts' Command Lines](#the-scripts-command-lines)
- [The Pre-Commit Hook and CI](#the-pre-commit-hook-and-ci)

---

## `npm` Project Commands

Every command in `package.json`, with its flags and an example, is in [`docs/npm-project-commands.md`](npm-project-commands.md).

---

## The Gate

`npm run check` runs `scripts/check.js`, the one local gate. It must pass before every commit and every push. Every check runs even after one fails, and a summary at the end lists each one with its result, so one run shows every problem.

### What It Runs

On Node.js 22.13 or newer, in this order:

| Stage | Tool | What fails it |
| --- | --- | --- |
| Lint (JavaScript) | ESLint, with `eslint.config.js` | Any error or warning |
| Lint (Markdown) | markdownlint-cli2 | Any rule broken |
| Format (JavaScript), Format (json), Format (yaml) | Prettier, in check mode | A file Prettier would change |
| Lint (GitHub Actions) | actionlint | A mistake in a workflow |
| Dead code (unused files) | knip, files only | A file nothing reaches |
| Dead code (modules only tests load) | `scripts/check-unused-src-modules.js` | A source module no entry point loads |
| Security lint | ESLint, with `eslint-security.config.js` | Any error or warning |
| Secret scan | secretlint | A credential in the files |
| Audit (shipped dependencies) | `npm audit`, runtime dependencies alone | A high or critical advisory |
| Audit (all dependencies, report only) | `npm audit`, every dependency | Never: it saves a report |
| Tests (shipped settings) | Node.js's test runner | A shipped value its tests refuse |
| Tests | Node.js's test runner, with coverage | Any failing test |
| Coverage | `scripts/_coverage.js` | See [Coverage](#coverage) |

Every stage but the tests and the coverage verdict is written down once, as data, in `scripts/_gate-stages.js`. `scripts/_run-stages.js` runs them, except the audit of every dependency, which `scripts/check.js` runs itself to save its report. `npm run lint` runs the stages from the JavaScript lint through the secret scan, and `scripts/format.js` and `scripts/audit.js` run one stage each. Two npm scripts spell out a stage's command again: `knip:files`, and `audit:deps`, which the Security Audit workflow runs.

First of all, the gate removes any test folder left behind by a test run that died. [Tests](#tests) says how it tells those folders apart.

### On Older Node.js Versions

On Node.js 20.0.0, the gate runs the features' tests alone. The lint, coverage and audit tools need Node.js 22.13 or newer, and so do the tests of the project's own tooling, which load those tools. The features' tests are the ones that matter on older versions: the validator runs Node.js 20.0.0.

### Reports

The gate writes its reports to `tmp/check/`, which git ignores: `lcov.info`, the tests' coverage, and `npm-audit-all.json`, the audit of every dependency. Each run replaces them.

---

## File Lists

`scripts/lint-targets.js` holds the file lists the checks share: ESLint's, Prettier's for JavaScript, the security lint's, the secret scan's, Markdown lint's, the dead-code checks', the test runner's and the coverage report's. Prettier's json and yaml globs sit in `scripts/_gate-stages.js`. knip adds the scripts, the lint rules and its project glob, in `knip.config.js`.

Every list is built from `FEATURES`, the names of the feature folders, so a new feature joins every check by being named there. Within a feature, the lists rely on three kinds of file, which `scripts/_project-files.js` finds:

- **Entry points**: the programs a person or a scheduler starts by their path. They sit directly in a feature's `src/` or `util/`, or in a `util/` tool's folder, as `index.js`.
- **Modules**: the files entry points load, in folders under `src/`, and a tool's other files.
- **Installed files**: files a feature copies into another program, such as nginx's njs module. No entry point loads them.

---

## Coverage

`scripts/_coverage.js` judges the lcov report the tests write, with three rules:

1. The lines of all measured files together must be at least 80% covered.
2. Each file in `HIGH_RISK_FILES`, in `scripts/check.js`, must reach 95% of its lines and of its branches on its own. These are the files whose failure would hurt the validator or leak the api key.
3. Every module and installed file must appear in the report at all. Node.js reports only the files a test loaded, so a file no test loads would otherwise escape the measure.

The measured files are each feature's `src/` and `util/`: the code that runs on the validator.

---

## Dead Code

Two checks, since neither catches everything alone:

- **knip**, files only, fails on a file nothing imports. It counts tests as entry points, so it passes a module that only tests load.
- **`scripts/check-unused-src-modules.js`** starts from the entry points alone, with madge, and fails on every source module it never reaches: code that runs in the tests and never on the validator.

An exported function nothing imports is fine. Only whole files are judged.

---

## Tests

Tests are files ending in `.test.js` in a test folder that `scripts/lint-targets.js` names: `test/`, for the project's own tooling, and each feature's `test/`. `scripts/_test-files.js` finds them.

Tests of the shipped settings end in `.config-values.test.js`, and the gate runs them before the rest. A bad shipped value would make many tests fail, and running these first names the cause.

Every test follows the same rules:

- **No test touches the machine.** A feature's code reaches the system only through its host, and tests pass a stand-in host instead. A test that must configure a real system belongs in [the system test](#the-system-test).
- **No test reads the operator's settings.** Tests load the settings from a temporary copy of `app-config/`.
- **Tests take the app's values from the app.** A test imports a constant, or loads a setting, rather than typing out its value, so it can't pass after the value moves. A test that shows a setting is used runs with every setting changed from its shipped value.
- **A test works in a temporary folder of its own.** `scripts/_test-temp-folders.js` makes it in the system's temporary folder, named with the test's purpose and its process id. The test process removes it on exit, and the gate removes, before its tests, the folders of processes that are gone.

---

## The System Test

`npm run test:system` runs x1-validator-private-rpc end to end on a real Ubuntu 24.04 system, with systemd, in a throwaway LXD container on the development machine. It never runs on a validator, and it isn't part of the gate. What it needs before it runs is in the feature README's [Test](../x1-validator-private-rpc/README.md#test) section.

`scripts/test-in-lxd.js` sets the container up the way a validator is set up:

1. It launches the container, and waits for it to finish booting.
2. It copies in Node.js 20.0.0, from nvm's download cache when there is one.
3. It copies in `package.json`, the lockfile and the feature's folder, without the operator's own settings, and installs the runtime dependencies, as a validator's install does.
4. It runs the tool's commands as the container's ordinary user, who has sudo, as a validator's account does.

Then it runs two phases:

- **The nginx upgrade check.** It runs `util/validate-nginx-upgrade/index.js`, which must pass, and must leave the container as it found it.
- **apply and the commands after it**, in `scripts/_lxd-apply-phase.js`. Pebble, Let's Encrypt's test server, stands in for Let's Encrypt, and a stand-in rpc plays the validator's. A git checkout plays x1console, where the settings put it. The commands' prompts are answered through a real terminal. It checks:
  - the request path, the firewall rule, the rate limit and nginx's logs
  - `ensure`'s failure while the rpc is still public, and every one of its verdicts after the validator's restart
  - the flag's return after `git stash`, and `unlock` after nginx comes back locked
  - both commands that switch private rpc, and a saved password
  - that `undo-apply` leaves the container as `apply` found it
  - last, that a firewall rule for port 443 with a comment, added while ufw is off, survives an `apply` stopped after its firewall stage, then `undo-apply`

Both phases decide what counts as left behind the same way, through `scripts/_lxd.js`. The paths come from the app: every absolute path in the settings the tool loads in the container, nginx.org's repository files, the folders above them all, and the nginx package and its user. The second phase adds the tool's own paths in the user's home and in the feature's folder. Whatever of those exists after a phase, and didn't before it, is a leftover. The second phase also checks that the firewall rule, the cron line and nginx's mask are gone, and that x1console's checkout is as committed. It reads the firewall rule from the rules the `ufw` command added, which ufw lists even while it's off, as it is in the container.

The test deletes the container at the end. With `--keep`, it stays, for a look inside.

---

## The Scripts' Command Lines

Each script run by its path declares its options with commander, through `scriptProgram` in `scripts/_tools.js`. So each one answers `--help` and `-h` with help made from its own options, and its exit codes, on stdout, with exit code 0. It refuses an option it doesn't take, on stderr, with exit code 1. `test/script-help.test.js` checks both, for every script run by its path.

Files whose names start with an underscore are helper modules, never run by their path. `scripts/_tools.js` also finds each tool's command in `node_modules/.bin`, never through npx, and finds the project's root from its own location, so the working directory never matters.

---

## The Pre-Commit Hook and CI

The pre-commit hook, `.husky/pre-commit`, runs `npm run lint`, and rewrites nothing. [`docs/npm-project-commands.md`](npm-project-commands.md) lists the commands that fix what it reports.

GitHub runs two workflows:

- **CI**, `.github/workflows/ci.yml`, on every push and pull request to `main`. It runs `npm ci`, then `npm run check`, on Node.js 20.0.0, 22 and 24. Its jobs are `Check (Node.js 20.0.0)`, `Check (Node.js 22)` and `Check (Node.js 24)`.
- **Security Audit**, `.github/workflows/security-audit.yml`. Its jobs are `Dependency Audit`, `Security Lint` and `Secret Scan`. [`docs/security.md`](security.md#the-audit-in-ci) says when it runs, and why.

`main` is protected. A change reaches it only through a pull request, and all six of those jobs must pass first. Renaming a job means updating the protection's required checks, or every pull request waits for a check that never comes.
