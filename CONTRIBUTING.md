# Contributing to Open Glean

## Getting set up

```bash
git clone https://github.com/hydra-db/open-glean.git
cd open-glean
npm ci
cp .env.example .env.local   # set OPEN_GLEAN_SESSION_SECRET
npm run dev
```

Chat persistence needs MongoDB. Without it the app degrades to localStorage and
shows a banner saying so, which is fine for most work.

## How contributions are gated

We use an issue-first flow, so that we can review each change. Talk to us on
[Discord](https://discord.gg/HcBKJHXmnu). Use the `#pr-discussion` channel to
ask about a PR, to ask for a review, or to ask us to close a PR.

```
open an issue  ->  issue /approved  ->  open a PR  ->  review & merge
   (anyone)         (maintainer)          (you)
```

1. Open an issue. Describe the bug or the change. Anyone can open an issue and discuss it.
2. Wait until a maintainer approves the issue with `/approved`.
3. Open a PR. Link the approved issue with `Closes #123`.
4. Keep the PR small. Change only what the issue asks for.

Only the issue author or a person assigned to the issue can open the PR for it.
To work on an issue that another person opened, comment on the issue. Ask a
maintainer to assign it to you. If a PR does not link an approved issue that is
yours, a bot closes it.

Pull request rules:

- Keep a maximum of 3 open PRs. If you open more, a bot closes your newest PR. Get an earlier PR merged or closed first. To ask, post in `#pr-discussion` on Discord.
- Fill in the "AI Assistance" section of the PR template. Do not remove it.
- Each PR has one thread in `#pr-discussion`.

A maintainer is a person in the `maintainers` list of
[`.github/vouched.json`](.github/vouched.json), or a person with write access
to this repository.

## Before you open a pull request

```bash
npm run typecheck
npm test
npm run build
```

Run these before every pull request. The project also runs `npm run lint` and
`npm audit`. Lint reports problems but does not fail the build. Do not add new
lint errors.

## What the tests are for

Most tests exist because something broke. The test names describe the failure,
not the function. Two areas need care:

- **`lib/xss-pipeline.test.ts`** guards the answer renderer, which turns LLM
  output into HTML. If you change `markdownToHtml`, `inlineMarkdown` or
  `linkCitations`, these tests prove your change is safe. Keep them green. If
  you add a transformation, add an attack vector for it.
- **`lib/safeUrl.test.ts` and `lib/safeFetch.test.ts`** guard the rules for
  outbound requests. Several past bypasses in that logic were fixed before it
  had tests, so treat a failure here as serious.

Tests that need a real MongoDB skip themselves when one is not reachable.

## Notes on the codebase

**Next.js 16 renamed `middleware.ts` to `proxy.ts`.** The proxy runs on the
Node runtime, not Edge. Read `node_modules/next/dist/docs/` before you write
Next code. Several conventions differ from earlier versions.

**When you fix something, check the sibling path.** The same operation often
exists twice: once in an API route and once in `lambda/handler.mjs`, or once
per caller of a shared client function. If you fix a route, check the Lambda.
If you fix one caller, check the others.

## Commits

Explain why, not what. The diff shows what changed. If you fix a bug, describe
what the user saw.
