# Contributing to Core Reconcile

Thank you for helping improve a reconciliation engine that can be reused across domains. Changes should preserve exact financial values, stable matching, traceability, and safe reruns.

## Local setup

Use Node.js 22.18 or newer and npm. Clone the repository, select your working branch, then run:

```sh
npm ci
npm run check
npm test
```

`npm ci` installs development tools and enables Husky hooks for this source checkout. CI and production installs skip hook setup. Hooks and development tools are not shipped in the npm tarball.

Git commit identity is independent of the GitHub organization that owns this repository. Check your identity before committing:

```sh
git config user.name
git config user.email
```

If necessary, set `git config --local user.name "Your Name"` and `git config --local user.email "YOUR_VERIFIED_OR_NOREPLY_EMAIL"`. Repository-local settings avoid changing your identity in unrelated projects.

## Checks and Git hooks

| Stage          | Checks                                                                                                            |
| -------------- | ----------------------------------------------------------------------------------------------------------------- |
| Before commit  | lint-staged formats staged package files with Prettier and lints staged code with ESLint.                         |
| Commit message | commitlint checks Conventional Commits.                                                                           |
| Before push    | TypeScript build and the package regression tests.                                                                |
| GitHub Actions | Formatting, ESLint, type checking, regression tests, installed-tarball checks, and streaming/Excel memory checks. |

lint-staged handles partially staged files and stages its fixes. Review the resulting diff. A rejected commit or push leaves your changes available to fix and retry. Hooks do not publish to npm or make financial updates.

Commands you can run directly:

```sh
npm run format
npm run format:check
npm run lint
npm run lint:fix
npm run check
npm test
npm run test:package
```

Generated files, local demo/server code, and the lockfile are excluded from formatting as configured in `.prettierignore`. npm maintains `package-lock.json`; commit it when dependencies change. ESLint scopes and exclusions are defined in `eslint.config.mjs`.

The hook scripts invoke local tools through Node, so they do not download packages through `npx`. Ensure Node is available to your terminal or Git GUI. If hooks were skipped during installation, run `npm run prepare` from the source checkout. Husky startup configuration may be needed when a GUI does not load your Node version manager.

## Commit messages

Use `type(optional-scope): description`, for example:

```text
feat(excel): support an additional worksheet option
fix(streaming): close both sources after a read failure
docs: explain pending recheck outcomes
test: cover duplicate composite identifiers
chore: update development dependencies
ci: verify package installation on Windows
```

Common types are `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `build`, `ci`, `chore`, and `revert`. Keep the description concise. Mark breaking changes with `!` and a `BREAKING CHANGE:` footer describing the migration. Commit types do not automatically publish or increment versions. CI validates the pull-request commit range or the latest commit for other workflow events.

## Write documentation before npm publication

Documentation does not depend on a registry release. Describe the current source API and run its examples locally. The README uses the intended npm installation command; a release maintainer must publish the matching version before registry installation is available.

| Document           | Purpose                                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------------------ |
| `README.md`        | Package introduction, Quickstart, inputs/outputs, rule/status meanings, supported use cases, and boundaries. |
| `docs/adapters.md` | Database and Excel input contracts, options, value semantics, limits, and cleanup.                           |
| `CHANGELOG.md`     | Versioned changes and migration notes; distinguish source versions from published registry releases.         |
| `CONTRIBUTING.md`  | Development setup, Git hooks, validation, and contribution workflow.                                         |

Build a local artifact:

```sh
npm ci
npm pack
```

In a separate application, install the generated tarball:

```sh
npm install /absolute/path/to/qpv-systems-core-reconcile-0.1.0.tgz
```

Use imports such as `import { reconcile } from '@qpv-systems/core-reconcile'`; installing the tarball preserves the package name. Run the README Quickstart and check its output against the documented result. `npm run test:package` also installs the artifact in an isolated temporary consumer and exercises its public exports with database and Excel inputs. It requires registry access to install the public runtime dependencies, but does not require npm publishing credentials.

When documenting a feature, show the input and rule configuration, the function call, an actual output, and the meaning of relevant statuses/errors. Use synthetic records and decimal strings. State completeness and ordering requirements. Keep all example outputs consistent with executable behavior. Declare supported functionality separately from future ideas.

Use relative links between repository documents so readers can navigate them locally and on GitHub. GitHub preview can help with presentation, but the Markdown source can be edited and reviewed without publishing anything.

## Change and review workflow

Create a branch for the change, make focused edits, run the relevant checks, and open a pull request. Explain the problem, resulting behavior, and validation. For matching or financial comparison changes, use explicit business rules and add tests for the affected edge cases. Changes to history, persistence, or worker coordination must describe the application boundary accurately.

Update documentation and the changelog when public behavior changes. During the initial `0.x` series, minor versions may contain API changes; patches should remain compatible. `config.version` identifies your business rules and is independent of the library version.

## Package and release boundaries

The package version is prepared for public release but has not been published to npm. A successful Git push or CI run does not publish it. Before a registry release, confirm the npm scope, publishing permissions, version, changelog, and artifact contents. Run `npm run test:package` to verify the consumer installation.

The current CI checks source and artifacts. It contains no publish step. npm account recovery and authorization are separate from documentation and development; continue working on those while publishing access is unavailable.
