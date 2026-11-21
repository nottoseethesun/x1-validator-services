# Security

This page records each security decision that needed a person's judgment: when the security audit runs, the security lint's exceptions, and the dependency overrides. It gives each one's reason. The rules come from the security guide of LP Ranger, another project by the same owner, as [CLAUDE.md](../CLAUDE.md) says. How x1-validator-private-rpc keeps its api keys is in that feature's [Api Key Security](../x1-validator-private-rpc/README.md#api-key-security) section.

## The Audit in CI

`.github/workflows/security-audit.yml` runs three jobs: the audit of the shipped dependencies, the security lint and the secret scan. It runs on every push and pull request to main, and once a day. The daily run is there because the advisory database changes on its own, so code nobody touched can start failing. Validators install from main, so main is the code operators run. The README's security badge shows the latest result.

## Security Lint Exceptions

### Rules Off for the Whole Project

- `security/detect-non-literal-fs-filename`. Its reason is written beside it in `eslint-security.config.js`.

### One-Line Exceptions

None yet. Each one is written in the code as `eslint-disable-next-line <rule> -- Safe: <reason>`, and listed here with its file and its reason.

## Dependency Advisories

The gate, `npm run check`, which must pass before every commit, fails on a high or critical advisory in the shipped dependencies. Advisories in the dev tools are fixed whenever a fix exists. Each fix below is an override in `package.json`, because the version range of the package that pulls the vulnerable one in leaves the fixed release out:

- `github-actionlint` takes `adm-zip` 0.6.1 or newer. Its own range is `^0.5.16`.
- `markdownlint-cli2` takes `katex` 0.18.2 or newer. `micromark-extension-math`'s range is `^0.16.0`.
- Every package takes `minimatch` 11.0.1 or newer. ESLint, and `@typescript-eslint/typescript-estree`, which madge pulls in, ask for `minimatch` 10. `npm` 11 writes the lockfile on the development machine, and the validator installs it with `npm` 9, which comes with Node.js 20.0.0, as [CLAUDE.md](../CLAUDE.md) says. `npm` 9 refuses the lockfile when the override names only ESLint and madge, so the override covers the whole tree. ESLint and madge are the only packages that use `minimatch`, so the wider override changes nothing else.

Two runs prove that `npm` 9 accepts the lockfile: the CI job on Node.js 20.0.0, and the system test, `npm run test:system`, which installs the project with Node.js 20.0.0 in an LXD container.

One known advisory has no fix yet: GHSA-fc5q-39xc-vjpf, a regular-expression denial of service in `picomatch`, which `knip`, `markdownlint-cli2`, `secretlint` and `madge` pull in. It reaches only the dev tools, which read the project's own files. An override follows once `picomatch` releases a fix.
