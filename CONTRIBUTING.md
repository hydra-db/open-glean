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

Contributions follow a gated flow to keep review load sustainable. Join us on
[Discord](https://discord.gg/YPtwenvxY8): discussing a PR, getting it reviewed
and merged, and getting an open PR closed all happen in the `#pr-discussion`
channel.

```
open an issue  ->  get vouched  ->  issue /approved  ->  open a PR  ->  review & merge
   (anyone)        (maintainer)       (maintainer)        (you)
```

1. Open an issue describing the bug or change. Anyone can open and discuss issues.
2. Get vouched. A maintainer vouches you with `/vouch @your-github-handle` on an issue (each maintainer may vouch at most 5 people). Maintainers are implicitly vouched. Ask on Discord.
3. A maintainer runs `/approved` on the issue once the discussion settles (only if its author is vouched).
4. Open a PR that links the approved issue (`Closes #123`). A PR with no linked, approved issue is closed automatically.

Pull request rules:

- At most 3 open PRs per person. The newest over that is closed; get an earlier one merged or closed first (ask in `#pr-discussion` on Discord).
- Keep PRs small and scoped to the approved issue.
- Fill in the AI-assistance section of the PR template and do not remove it.
- Each PR gets a single thread in `#pr-discussion`.

The roster lives in [`.github/vouched.json`](.github/vouched.json). Anyone with
write access is treated as a maintainer.

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
