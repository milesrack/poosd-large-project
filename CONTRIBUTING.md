# Contributing to Zetafly

## Development

Follow the [setup instructions](README.md#installation), then create a branch from `main`:

```sh
git switch main
git pull --ff-only
git switch -c bugfix/short-description
```

Use `feature/`, `bugfix/`, `refactor/`, `docs/`, or `chore/` as appropriate. Follow the existing TypeScript code style, and keep each pull request focused on one change.

```sh
npm run format
npm run check
```

`check` runs formatting, lint, OpenAPI validation, unit tests, strict TypeScript checks, and the production build. Add a regression test for a bug fix, and update the README when setup or usage changes.

With Docker running:

```sh
npm run test:integration
npx playwright install chromium webkit
npm run test:e2e
```

For simulator changes, run `npm run model:fetch && npm run test:simulator`.

## Pull requests

Use [Conventional Commits](https://www.conventionalcommits.org/), for example `fix: preserve playback position`. Open pull requests against `main`, link the related issue, and describe how you tested the change. Include screenshots for visible UI changes.

Pull requests must pass CI before merging to `main`, where the release workflow publishes and deploys the app.

## Issues

Use the bug report form for reproducible problems and the task form for planned work. Search existing issues first. Include reproduction steps and your browser or Node.js version in bug reports; give tasks a clear outcome and acceptance criteria.
