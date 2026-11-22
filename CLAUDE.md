# CLAUDE.md

This file guides Claude Code, and anyone else working in this repository.

## Purpose

X1 Validator Services is a home for features whose code runs on an X1 validator itself. Each feature lives in a sub-directory of its own. The validator is set up by `x1console`, the program that installs it and starts it.

The first feature is x1-validator-private-rpc. It's a command-line tool that makes the validator's rpc private and puts it behind an https url that carries an api key. Its `apply` command sets all of that up on the validator. Its design is in its `docs/architecture.md` and `docs/engineering.md`.

## Conventions

[LP Ranger](https://github.com/nottoseethesun/lp-ranger)'s conventions are the authority for this project. They cover code style, tests, the gate, security, docs, the `git` workflow and how to work with the owner. The gate is the set of checks that must pass before every commit and every push, `npm run check` here. Read LP Ranger's conventions in this order:

1. its `CLAUDE.md`
2. its `docs/claude/CLAUDE-*.md` guides, skipping `CLAUDE-DISCLOSURES.md`
3. its `docs/claude/memory/MEMORY.md`, and the `feedback_*` notes it lists

Skip what belongs to LP Ranger's own domain: EVM, chains, pools and positions, its dashboard and its CSS. This file keeps no copy of LP Ranger's rules, so the two can't drift apart. It records only where this project differs, below.

## Where This Project Differs From LP Ranger

- **ES modules.** Every file is an ES module. Translate LP Ranger's CommonJS examples: `import` and `export`, file extensions in relative imports, and `fileURLToPath(import.meta.url)` where LP Ranger uses `__dirname`.
- **Node.js versions.** The whole project, its features and its tools, supports one range: Node.js 24 or newer, as `engines`, `>=24`, in `package.json` says. CI tests the two long-term-support majors in that range, on the newest release of each: the newest major, 26 now, and the one two majors before it, 24. Every script and every `npm run` target must run on both. On a validator, the features run on the older one, 24, since a validator can't always move to the newest at once. `x1console`'s own Node.js 20.0.0 stays there too, for `x1console`'s scripts, and `nvm` holds both. eslint-plugin-n holds all the code to the oldest version `engines` allows. No tool, the build included, pins a Node.js version: `engines` takes a minor only when a tool truly needs one. The scripts in `scripts/`, the features' programs and the system test's container take the minimum from `engines`, and each script and program stops on an older Node.js. When a newer major becomes long-term-support, `engines`, the Node.js versions in the three workflows, CI, Security Audit and System Test, and the docs move up together. Each validator then adds, with `nvm`, the major `engines` now names, and runs `npm ci` and `apply` on it, as a feature's Update steps say.
- **Names that outlive a version.** Moving CI to newer versions, of Node.js or of anything else, never renames a file, a job or a check. Each is named for its role, never for a version's number: CI's jobs are `check-oldest-nodejs-supported` and `check-newest-nodejs-supported`. So a move changes only the version numbers, and the checks the branch protection requires keep their names.
- **Runtime dependencies.** They are commander 15, Ajv 8, dotenv 18, and ora 10, which draws the terminal spinner. Every other package is a dev dependency.
- **Only the entry point runs at load.** Every module other than a program's entry point only declares imports, constants, functions and exports. Two LP Ranger rules exist only because its modules read settings as they load, so they don't apply here: setting overrides before a module loads, and keeping diagnostic tools from importing shared modules.
- **One repository, several features.** One `package.json` and one `node_modules` at the root serve every feature. Run every `npm` command from the root. Each feature's details go in its own `README.md`. The root `README.md` holds only what applies to the whole project.
- **System tests.** A test that configures a system, with packages, `systemd`, `nginx`, `ufw` or `cron`, runs in an LXD container on the development machine, through `npm run test:system`. No test runs on a validator. Every effect on the system goes through the host, an object that `src/lib/host.js` makes and the code receives as an argument. So unit tests pass a fake host, from `test/helpers/`, instead.
- **`apt`, never `apt-get`.** Code, tests and docs call `apt`, as `x1console` and nginx.org's instructions do, and never `apt-get` or `apt-cache`. Each call from code passes `-o Apt::Cmd::Disable-Script-Warning=true`, which stops `apt` warning that a program runs it.
- **Installs come from `main`.** There are no releases: a validator installs and updates with `git pull` on `main`. So LP Ranger's release steps, its release notes, tags and release audit, don't apply.
- **The gate.** Its reports go to `tmp/check/`. Besides LP Ranger's coverage rules, it fails a source module that no test loads, since Node.js reports coverage only for the files a test loaded. The list of files held to 95% coverage is in `scripts/check.js`. Its last stage, code-fuzzing, makes small changes to each feature's code in memory, and checks that a test fails for each.
- **Program names in backticks.** Every Markdown doc writes a program's name in backticks, as it's typed on the command line: `nginx`, `systemd`, `apt`, `ufw`, `git`, `cron`, `x1console`, `npm`. That holds in headings, tables and link text too, and inside terms such as the `cron` job or the tool's `git` hook. A product's name in its own spelling, such as Node.js, ESLint, LXD or Ubuntu, stays plain, and so does a site or a service, such as nginx.org or Let's Encrypt. A feature's own name stays plain, except as a command.
- **Each tool introduced at its first mention.** A reader reads a doc top to bottom, and knows only what it has said so far. So each tool in the project must be properly introduced at its first mention in a doc, a help text or a message. That means starting from the big picture, giving a few words that explain the context, or an example scenario in which the tool would be used, and explaining in precise language, with no AI slop, such as an adjective where the reader needs an explanation. The tools are a feature's commands, such as `apply` or `ensure`, its standalone tools, and each `npm run` target and the script it runs.
- **Complete help.** LP Ranger asks every program to answer `--help` and `-h`. Here the help must also be complete: it lists every option the program takes, and gives usage examples, with one for each common use. It holds for every `npm run` target, `prepare` included, which `npm install` runs to set up the `git` pre-commit hook, and for every command-line tool in the project: a feature's tool and each of its commands, its standalone tools, and each script in `scripts/` that's run by its path, even one that only other scripts run. An `npm run` target that needs another program, such as `knip`, `npm audit` or `husky`, runs it through a script of the project's, so its `--help` is the project's own. Tests fail a target that runs no such script, and any help that gives no examples, so the gate keeps them complete.
- **The security pass.** `security/detect-non-literal-fs-filename` is off for the whole project. Its reason is beside it in `eslint-security.config.js`. [docs/security.md](docs/security.md) lists every exception and every dependency override.

## Layout

```text
package.json             one for the whole project
eslint.config.js         the main lint rules
eslint-security.config.js  the security pass
knip.config.js           the unused-file check
scripts/                 the gate and the runners of the tools
  lint-targets.js        the file lists the checks share
test/                    tests of the project's own tooling
eslint-rules/            this project's lint rules
docs/                    project-wide docs, the engineering reference among them
x1-validator-private-rpc/
  README.md              the feature's install steps and use
  app-config/            shipped settings, their schema and apply's dictionary of the changes it can make on the machine; per-install overrides
  docs/                  its commands, its architecture, its engineering reference, and the manual domain setup
  examples/              a copyable example of each file apply renders
  certs/                 Let's Encrypt's staging roots, for apply --acme-staging
  bin/                   the tool's launcher, which runs it on the Node.js `engines` names
  src/cli.js             its entry point
  src/cli/               the commands' modules, which the entry point loads
  src/lib/               modules shared by its programs, the host included
  src/njs/               the key check nginx runs, installed as is
  util/validate-nginx-upgrade/  the first install step, a standalone tool that proves an nginx upgrade keeps a keyed url working
  util/check-my-private-rpc/    a one-off check of the keyed url, a standalone tool
  test/                  its tests; helpers/ holds the fake hosts
  app-data/, logs/, tmp/ made on the validator; git ignores them
```

Entry points sit directly in a feature's `src/`, and standalone tools in its `util/`. Modules sit in folders under `src/`, grouped by the entry point that loads them, with shared ones in `src/lib/`. A new feature joins every check when it's added to `FEATURES` in `scripts/lint-targets.js`. It also needs a list of code-fuzzing changes, its `test/code-fuzzing.json`, with at least one entry, or the gate's last stage fails.

## Commands

`npm run check` is the gate. It must pass before every commit and every push. Every `npm` command, with its options and an example, is in [docs/npm-project-commands.md](docs/npm-project-commands.md). How the gate, the tests and the system test work is in [docs/engineering.md](docs/engineering.md). Each feature's design is in its `docs/architecture.md` and `docs/engineering.md`.
