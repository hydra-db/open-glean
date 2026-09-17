# Security policy

## Reporting a vulnerability

Email **security@hydradb.com**. Do not open a public issue for a
vulnerability.

Include what you can: what you found, how to reproduce it, and what an attacker
gets. A proof of concept helps. You will get an acknowledgement within three
working days.

Do not test against a deployment you do not own. Run Open Glean locally instead.

## What Open Glean handles

Open Glean holds API keys and makes requests for the user. These are the parts
that matter:

- **Credentials.** The Hydra and LLM keys live in an AES-256-GCM-encrypted
  httpOnly cookie and are used server-side. They are never sent to the browser.
- **Outbound requests.** The server fetches URLs that a caller can influence:
  the LLM endpoint, the Hydra base URL, and the webpage-ingest endpoint. Report
  it if a caller can send a stored key to a host of their choice, or reach a
  private address. See `lib/safeUrl.ts` and `lib/safeFetch.ts`.
- **Chat isolation.** Each conversation belongs to an anonymous per-browser
  subject (`lib/subject.ts`). Report it if you can read, change or delete
  another subject's chats.
- **Rendered answers.** Open Glean renders LLM output as HTML, and that output can
  quote documents other people wrote. Report it if you can run a script from an
  answer. See `lib/citationMarkup.ts` and `lib/xss-pipeline.test.ts`.

## What is not a vulnerability

- **The anonymous subject is not authentication.** It identifies a browser, not
  a person. Anyone who uses the same browser profile has the same access. This
  is a known limit.
- **A deployment that sets `HYDRA_API_KEY` shares that key with every
  visitor.** That is what the setting does. Put the deployment behind your own
  access control.
- **`OPEN_GLEAN_ALLOW_PRIVATE_LLM_URL=true` allows plaintext requests to private
  addresses.** This setting exists for local models.

## Supported versions

Fixes land on `main`. There are no backported releases.
