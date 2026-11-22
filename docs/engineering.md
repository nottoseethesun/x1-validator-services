# X1 Validator Services — Engineering Reference

X1 Validator Services holds features, tools whose code runs on an X1 validator, each in a folder of its own. This is the reference for the engineering they share. The gate, `npm run check`, runs the checks that must pass before every commit. This doc covers the gate and each of its checks, the lists of files the checks read, and the rules every test follows. It also covers the scripts behind the `npm` commands, CI, and the system test, which runs a feature on a real system in an LXD container. The project needs Node.js 24 or newer, as [Node.js Versions](#nodejs-versions) explains.

Each feature's own design is in its folder. For x1-validator-private-rpc, read [`architecture.md`](../x1-validator-private-rpc/docs/architecture.md), then [`engineering.md`](../x1-validator-private-rpc/docs/engineering.md).

Other references:

- [`CLAUDE.md`](../CLAUDE.md): the repository's layout, and its conventions. They're the conventions of LP Ranger, another project by the same owner, and `CLAUDE.md` lists where this project differs.
- [`docs/npm-project-commands.md`](npm-project-commands.md): every `npm` command, and what to type.
- [`docs/security.md`](security.md): the security checks' exceptions, and the dependency overrides.

---

## Table of Contents

- [`npm` Project Commands](#npm-project-commands)
- [The Gate](#the-gate)
  - [What It Runs](#what-it-runs)
  - [Node.js Versions](#nodejs-versions)
  - [Reports](#reports)
- [File Lists](#file-lists)
- [Coverage](#coverage)
- [Dead Code](#dead-code)
- [Tests](#tests)
- [Code-Fuzzing](#code-fuzzing)
- [The System Test](#the-system-test)
- [The Scripts' Command Lines](#the-scripts-command-lines)
- [The Pre-Commit Hook and CI](#the-pre-commit-hook-and-ci)

---

## `npm` Project Commands

Every command in `package.json`, with its flags and an example, is in [`docs/npm-project-commands.md`](npm-project-commands.md).

---

## The Gate

`npm run check` runs `scripts/check.js`, the one local gate. It must pass before every commit and every push. Every check but the last runs even after one fails. The last, code-fuzzing, makes small changes to a feature's code in memory, and checks that a test fails for each, as [Code-Fuzzing](#code-fuzzing) explains. It runs only once every test has passed: with a test failing, the gate fails anyway, and it's the gate's slowest stage. A summary at the end lists each check that ran, with its result, so one run shows every problem.

### What It Runs

First of all, the gate removes any test folder left behind by a test run that died. [Tests](#tests) says how it tells those folders apart.

Then it runs these, in this order:

| Stage | Tool | What fails it |
| --- | --- | --- |
| Lint (JavaScript) | ESLint, with `eslint.config.js` | Any error or warning |
| Lint (Markdown) | `markdownlint-cli2` | Any rule broken |
| Format (JavaScript), Format (json), Format (yaml) | Prettier, in check mode | A file Prettier would change |
| Lint (GitHub Actions) | `actionlint` | A mistake in a workflow |
| Dead code (unused files) | `knip`, files only | A file nothing reaches |
| Dead code (modules only tests load) | `scripts/check-unused-src-modules.js` | A source module no entry point loads |
| Security lint | ESLint, with `eslint-security.config.js` | Any error or warning |
| Secret scan | `secretlint` | A credential in the files |
| Audit (shipped dependencies) | `npm audit`, runtime dependencies alone | A high or critical advisory |
| Audit (all dependencies, report only) | `npm audit`, every dependency | Never: it saves a report |
| Tests (shipped settings) | Node.js's test runner | A shipped value its tests refuse |
| Tests | Node.js's test runner, with coverage | Any failing test |
| Coverage | `scripts/_coverage.js` | See [Coverage](#coverage) |
| Code-fuzzing, once the tests pass | `scripts/check-code-fuzzing.js` | A change its test doesn't catch. See [Code-Fuzzing](#code-fuzzing) |

Every stage but the tests, the coverage verdict and code-fuzzing is written down once, as data, in `scripts/_gate-stages.js`. `scripts/_run-stages.js` runs them, except the audit of every dependency, which `scripts/check.js` runs itself to save its report. The scripts behind the other `npm` commands take their stages from the same file:

- `npm run lint` runs every check but the tests and the audits of the dependencies: the lints of JavaScript, Markdown and GitHub Actions, the format checks, the two checks for dead code, the security lint and the secret scan. The `git` pre-commit hook runs it before each commit.
- `scripts/format.js`, behind `npm run format` and `format:check`, runs Prettier on the JavaScript: `format` when the lint reports unformatted JavaScript, `format:check` to list the files without changing them.
- `scripts/audit.js` runs one of the gate's four security checks alone, such as to recheck a fix, through four targets: `audit:security` the security lint, `audit:secrets` the secret scan, `audit:deps` the audit of the shipped dependencies, and `audit:deps:all` the audit of every dependency. Each target fails on what its check finds. The gate fails on the first three, and only saves the fourth's report. The Security Audit workflow runs the first three on GitHub.
- `scripts/check-unused-files.js`, behind `npm run knip:files`, lists the files nothing imports, which the gate fails on. Run it alone, such as after moving or deleting a file.

### Node.js Versions

The whole project, its features and its tools, supports one range of Node.js versions: 24 or newer, as `engines`, `>=24`, in `package.json` says. CI tests the two long-term-support majors in that range, on the newest release of each: the newest major, 26, and the one two majors before it, 24. Every script and every `npm` command runs on both. On a validator, the features run on 24, the older major, since a validator can't always move to the newest at once. They run beside `x1console`'s own Node.js 20.0.0. No tool pins a version, and `engines` names no minor, since no tool needs a later release than 24.0.0. Every script reads that minimum from `engines`, through the feature's `src/lib/node-version.js`, which the feature's programs use too, so the two can't drift. On an older version, a script stops. eslint-plugin-n reads the minimum from `engines` too, and the lint fails code that uses an api or syntax newer than that. When a newer major becomes long-term-support, `engines`, the Node.js versions in the three workflows, CI, Security Audit and System Test, and the docs move up together, and CI's jobs keep their names, as [The Pre-Commit Hook and CI](#the-pre-commit-hook-and-ci) says.

### Reports

The gate writes its reports to `tmp/check/`, which `git` ignores: `lcov.info`, the tests' coverage, and `npm-audit-all.json`, the audit of every dependency. Each run replaces them.

---

## File Lists

`scripts/lint-targets.js` holds the file lists the checks share: ESLint's, Prettier's for JavaScript, the security lint's, the secret scan's, Markdown lint's, the dead-code checks', the test runner's and the coverage report's. Prettier's json and yaml globs sit in `scripts/_gate-stages.js`. `knip` adds the scripts, the lint rules and its project glob, in `knip.config.js`.

Every list is built from `FEATURES`, the names of the feature folders, so a new feature joins every check by being named there. It also needs a list of code-fuzzing changes, its `test/code-fuzzing.json`, with at least one entry, or the gate's last stage fails. Within a feature, the lists rely on three kinds of file, which `scripts/_project-files.js` finds:

- **Entry points**: the programs a person or a scheduler starts by their path. They sit directly in a feature's `src/` or `util/`, or in a `util/` tool's folder, as `index.js`.
- **Modules**: the files entry points load, in folders under `src/`, and a tool's other files.
- **Installed files**: files a feature copies into another program, such as `nginx`'s njs module. No entry point loads them.

---

## Coverage

`scripts/_coverage.js` judges the lcov report the tests write. It applies three rules to the code that runs on the validator, each feature's `src/` and `util/`:

1. The lines of all measured files together must be at least 80% covered.
2. Each file in `HIGH_RISK_FILES`, in `scripts/check.js`, must reach 95% of its lines and of its branches on its own. These are the files whose failure would hurt the validator or leak an api key.
3. Every module and installed file must appear in the report at all. Node.js reports only the files a test loaded, so a file no test loads would otherwise escape the measure.

---

## Dead Code

Two checks, since neither catches everything alone:

- **`knip`**, files only, fails on a file nothing imports. It counts tests as entry points, so it passes a module that only tests load.
- **`scripts/check-unused-src-modules.js`** starts from the entry points alone, with madge, and fails on every source module it never reaches: code that runs in the tests and never on the validator.

An exported function nothing imports is fine. Only whole files are judged.

---

## Tests

Tests are files ending in `.test.js` in a test folder that `scripts/lint-targets.js` names: `test/`, for the project's own tooling, and each feature's `test/`. `scripts/_test-files.js` finds them. `npm test` runs every test once, without the gate's other checks, for a quick run while you work.

Tests of the shipped settings end in `.config-values.test.js`, and the gate runs them before the rest. A bad shipped value would make many tests fail, and running these first names the cause.

Every test follows the same rules:

- **No test touches the machine.** A feature's code reaches the system only through its host, an object whose functions run commands, change files and make requests. The code receives the host as an argument, so tests pass a stand-in instead. A test that must configure a real system belongs in [the system test](#the-system-test).
- **No test reads the operator's settings.** A feature's `app-config/` folder holds its shipped settings and, in a folder of its own, the operator's. Tests load a temporary copy that leaves the operator's folder out.
- **Tests take the app's values from the app.** A test imports a constant, or loads a setting, rather than typing out its value, so it can't pass after the value moves. A test that shows a setting is used runs with every setting changed from its shipped value.
- **A test works in a temporary folder of its own.** `scripts/_test-temp-folders.js` makes it in the system's temporary folder, named with the test's purpose and its process id. The test process removes it on exit, and the gate removes, before its tests, the folders of processes that are gone.

---

## Code-Fuzzing

Tests can all pass and still miss the bugs they're meant to catch. The gate's last stage, code-fuzzing, checks that they don't. Where the usual fuzzing feeds a program random input, code-fuzzing changes the code itself, from a fixed list: small changes to a feature's code, of the kind a slip in an edit would make, each paired with the test file that must fail when the change is made. When a test file still passes with its change made, that test has a hole, and the gate fails.

Each feature lists its changes in its `test/code-fuzzing.json`. A new feature needs that list too, with at least one entry, or the stage fails. Each entry has:

- `name`: what the change does, in a few words
- `file`: the file it changes, from the feature's folder
- `edits`: the text to change, `from`, and what to change it `to`. Each `from` must be in the file exactly once, so the entry can't change the wrong place.
- `test`: the test file that must fail, from the feature's folder

`scripts/check-code-fuzzing.js` makes each change in a process of its own, and never changes a file on disk. `npm run test:fuzzing` runs it alone, without the rest of the gate, such as after adding a change to a feature's list. For each change, `scripts/try-code-fuzzing.js` runs the entry's test file, with a load hook: Node.js hands the hook each file's text after reading it, and runs the text the hook returns, so the hook makes the edits in memory. A run stops at the first failing test, since one is enough. The runs go side by side, as many at once as the machine has processors.

A finished run reports whether it made each of its entry's edits. An edit not made means its test file never loaded the file it changes, so the change was never made, and the stage fails it as not made. A run still going after 5 minutes is stopped, and can't report its edits. The stage counts it as caught, since its test file didn't pass in that time, and prints it as "CAUGHT, AFTER TIMING OUT".

The stage fails when:

- a change's test file passes with the change made
- the test never loads the file the change edits, so the change isn't made
- an entry is wrong. An entry's `from` text is the text its change replaces. A maintainer's edit to the feature's code can leave that text missing from its file, or there more than once. `test/code-fuzzing.test.js` checks the entries too, so `npm test` shows a wrong entry at once.
- a test file the entries name fails with no change made. The stage runs each one first, since a test that fails already would make every change look caught.

The load hook uses Node.js's `module.registerHooks`, which every Node.js the project supports has. A resolve hook beside it gives the changed file a url of its own, with a query added. Node.js loads each module's url only once, and the runner may have loaded that file itself before its hooks exist, such as `src/lib/node-version.js`, which `scripts/_tools.js` imports. Under the new url, Node.js loads the file again, through the load hook, for the test file.

When a new test is written to catch a bug, add the change that bug would make as an entry. The gate then fails if the test ever stops catching it.

---

## The System Test

The tests above hand the feature a stand-in for the system, so none of them shows that the real `apt`, `systemd`, `nginx`, `ufw` and `cron` behave as the feature expects. The system test does. `npm run test:system` runs x1-validator-private-rpc end to end on a real Ubuntu 24.04 system, with `systemd`, in a throwaway LXD container. It runs on the development machine, or on GitHub's runner when someone starts the System Test workflow, which [The Pre-Commit Hook and CI](#the-pre-commit-hook-and-ci) describes. It never runs on a validator, and it isn't part of the gate. Run it before you merge a change to a feature's code. What it needs before it runs is in the feature README's [Test](../x1-validator-private-rpc/README.md#test) section. Its checks use the feature's own terms, which its [README](../x1-validator-private-rpc/README.md) and [architecture](../x1-validator-private-rpc/docs/architecture.md) explain: read those first.

`scripts/test-in-lxd.js` sets the container up the way a validator is set up:

1. It launches the container, and waits for it to finish booting.
2. It copies in the newest release of the Node.js major `engines` names, 24, the one validators run the features on. It finds that release in nodejs.org's list of releases. It copies it from `nvm`'s download cache when it's there, and otherwise has the container download it from nodejs.org.
3. It copies in `package.json`, the lockfile and the feature's folder, without the operator's own settings, and installs the runtime dependencies, as a validator's install does.
4. It runs the tool's commands as the container's ordinary user, who has `sudo`, as a validator's account does.

A command that asks anything runs in a real terminal, which the `script` program makes, and its prompts are answered as they appear. One is the disclaimer: every run that can change the system shows it first, in a dialog `whiptail` draws, and goes on only once Affirm is chosen. Decline has the focus at first, and Affirm sits to its left. So once `whiptail` draws the Decline button, the test presses the left arrow and Enter.

Then it runs two phases:

- **The `nginx` upgrade check.** It runs `util/validate-nginx-upgrade/index.js`, the feature's standalone tool that proves, with a throwaway api key, that an `apt` upgrade of `nginx` keeps the feature's url working. It must pass, and must leave the container as it found it.
- **`apply`, which sets the feature up, and the commands after it**, in `scripts/_lxd-apply-phase.js`. Pebble, Let's Encrypt's test server, stands in for Let's Encrypt, and a stand-in rpc plays the validator's. `x1console`, which starts the validator, is a `git` checkout that holds the start script the tool edits. In the test, a checkout stands in for it, at the path the settings give, cloned from a local repository that stands in for `x1console`'s on GitHub. After `apply`, it runs every other command. `ensure`, which a `cron` job runs every minute on a validator, puts back `--private-rpc`, the start script's flag that keeps the rpc private, after an `x1console` update takes it out, and checks every part. `url` prints the url's https and wss forms. `add-api-key` and `remove-api-key` make and remove api keys, and the key count check, `ensure-there-is-at-least-one-rpc-api-key`, alerts when no key is left. `turn-off-private-rpc` and `turn-on-private-rpc` switch the rpc between public and private, and `undo-apply` takes back what `apply` did. The phase checks:
  - the first key `apply` shows, the saved password `systemd-creds` holds, the request path, a random key's 403, the firewall rule, the rate limit, and that `nginx`'s logs hold no key, show `<key>` in its place, and keep the mode nginx.org's package gives them: 640, owner `nginx`, group `adm`
  - that `nginx`'s main process has its own read-only `/dev`, and still serves after a log reopen
  - `ensure`'s failure while the rpc is still public, and every one of its verdicts after the validator's restart
  - the flag put back by the tool's `git` hook, when `git stash` and a `git pull` that brings a new commit play an Update X1 Console, and the key still working after a restart of `nginx`
  - `nginx`'s log folder deleted, then made again by the drop-in before a restart of `nginx`, then deleted again, and made again by `add-api-key` before its reload
  - two keys from `add-api-key`, then `remove-api-key` on one of them: it gets 403 and the rest still work
  - the connections the removed key held open through its removal, which `x1-validator-private-rpc/test/helpers/reload-probe.js` opens. An http/1.1 one kept alive and an http/2 one no longer answer for it, and a websocket closes within the old worker's time limit.
  - both commands that switch private rpc, and a later `apply` that asks nothing
  - `undo-apply` answered no, which keeps the keys and the saved password, and the next `apply`, which hands `nginx` the same keys
  - that the last `undo-apply`, answered yes, leaves `nginx` installed, stopped and masked, and says how to purge it
  - that once the test purges `nginx`, a second `undo-apply` leaves the container as `apply` found it, with Autopilot's job still in the `crontab` and the start script still executable
  - last, that a firewall rule for port 443 with a comment, added while `ufw` is off, survives an `apply` stopped after its firewall stage, then `undo-apply`, a purge of `nginx` and `undo-apply` again

Both phases decide what counts as left behind the same way, through `scripts/_lxd.js`. A leftover is anything watched that exists after a phase and didn't before it. What's watched comes from the app: every absolute path in the settings the tool loads in the container, nginx.org's repository files, `nginx`'s log folder, the folders above them all, and the `nginx` package and its user. The second phase adds the tool's own paths in the user's home and in the feature's folder. It also checks that the firewall rule, both `cron` lines and `nginx`'s mask are gone, and that `x1console`'s checkout is as committed. It reads the firewall rule from the rules the `ufw` command added, which `ufw` lists even while it's off, as it is in the container.

The test deletes the container at the end. With `--keep`, it stays, for a look inside.

---

## The Scripts' Command Lines

Each script run by its path declares its options with commander, through `scriptProgram` in `scripts/_tools.js`. So each one answers `--help` and `-h` with help made from its own options, its usage examples and its exit codes, on stdout, with exit code 0. It refuses an option it doesn't take, on stderr, with exit code 1. `test/script-help.test.js` checks both, for every script run by its path, and fails a help that gives no examples. Each script also stops on a Node.js older than 24, as [Node.js Versions](#nodejs-versions) says, and the same test fails a script that doesn't check. It also fails an `npm run` target that runs no script of the project's, so every target's `--help` is one of these.

Files whose names start with an underscore are helper modules, never run by their path. `scripts/_tools.js` also finds each tool's command in `node_modules/.bin`, never through `npx`, and finds the project's root from its own location, so the working directory never matters.

---

## The Pre-Commit Hook and CI

The pre-commit hook, `.husky/pre-commit`, runs `npm run lint`, and rewrites nothing. [`docs/npm-project-commands.md`](npm-project-commands.md) lists the commands that fix what it reports. `npm ci` sets the hook up on a development machine. It runs the `prepare` target, whose script, `scripts/prepare.js`, runs `husky`, the package that installs `git` hooks.

GitHub runs three workflows:

- **CI**, `.github/workflows/ci.yml`, on every push and pull request to `main`. It runs `npm ci`, then `npm run check`, on two versions of Node.js, in jobs named for each version's role, not its number: `check-oldest-nodejs-supported` on the newest Node.js 24, and `check-newest-nodejs-supported` on the newest Node.js 26. The step that installs Node.js, `actions/setup-node`, fetches the newest release of each major, since `check-latest` is on: without it, the step takes an older release that GitHub's runner already holds. When a newer major becomes long-term-support, only the version numbers move, so the jobs' names, which the branch protection requires, stay the same.
- **Security Audit**, `.github/workflows/security-audit.yml`. Its jobs are `Dependency Audit`, `Security Lint` and `Secret Scan`. [`docs/security.md`](security.md#the-audit-in-ci) says when it runs, and why.
- **System Test**, `.github/workflows/system-test.yml`, only when someone starts it, from the Actions tab or with `gh workflow run system-test.yml`, since [the system test](#the-system-test) takes about ten minutes. Its one job, `System Test`, installs LXD on GitHub's Ubuntu runner with Canonical's action, `canonical/setup-lxd`, then runs `npm run test:system`. GitHub can start a workflow by hand only once the workflow is on `main`.

`main` is protected. A change reaches it only through a pull request, and the five jobs of CI and Security Audit must pass first. No pull request waits for the system test. Renaming a job means updating the protection's required checks, or every pull request waits for a check that never comes.
