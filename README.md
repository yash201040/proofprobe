# ProofProbe

Live: https://proofprobe.forested-wolfberry.workers.dev

Two-step research that turns any starting point into a clear, data-backed path: a job or interview to prepare for, a search for side income, a startup idea, or another goal.

1. **Broad probing:** research the goal, then publish exhaustive personalised questions.
2. **In-depth research:** when asked, read the latest submission and publish the path on the same page, as one recommendation or up to three alternatives.

- **`/proofprobe` skill** (`skills/proofprobe/SKILL.md`): runs in Claude Code. Opus does the thinking and treg does the live research, so the server needs no AI key.
- **Worker** (`src/`): hosts the home page and the Probes directory, organised as profiles with one or more pages. Anyone can view a page, and signing in to the profile unlocks editing.
- **`bin/proofprobe.mjs`**: admin helper to create, publish, check and fetch cases.

## For agents and other chats

Read `CLAUDE.md` for the expected flow. In any Claude Code chat, `/proofprobe` runs it, including moving research that was started elsewhere onto a page.

## Setup

```
npm install
node bin/proofprobe.mjs init --url https://<worker-url>
ln -s "$PWD/skills/proofprobe" ~/.claude/skills/proofprobe
npx wrangler login
npx wrangler secret put ADMIN_TOKEN_SHA256     # paste the hash printed by init
openssl rand -base64 32 | npx wrangler secret put PASSWORD_KEY
npx wrangler deploy
node bin/proofprobe.mjs admin-setup             # open the link to choose the master password
```

Local test: put `ADMIN_TOKEN_SHA256=<hash>` and `PASSWORD_KEY=<base64 key>` in `.dev.vars`, run `npm run dev`, then `npm run test:e2e`. The test only ever talks to localhost. `npm run typecheck` checks the Worker.

## Data rules

- Anyone can read each page's research, questions, status and cost, and a notice says so. Answers stay private to the signed-in profile and the owner. People apply for a profile, the owner approves it, and signing in unlocks that profile's pages and no others. People can change their own password once signed in.
- Each research stage is a step, shown as a view on the same page. New research adds a step and never replaces one.
- Submitting stores a log and starts nothing. Research continues only when `/proofprobe` is run.
- The cost shown on a page is treg data spend logged with `proofprobe cost`. Claude usage is not included.
- Submissions are append-only. A database trigger blocks updates, and each log stores a SHA-256 so corruption is detectable.
- Page content is rendered as text only, so stored content cannot inject markup.
- CVs and research notes stay in `.proofprobe/` on this machine, which git ignores. Only questions, intro, plan and costs go to the server.
- Answer text and tokens are never logged.

## Design choices

This is a small free-tier app: one Cloudflare Worker and a D1 database, with no user accounts. D1 can be moved to Postgres later with pgloader if the tool outgrows it. The schema is applied on first request, so there is no separate migration step.

## Open source and access

The code is public, but the running service is not. Cases, answers and links live in the owner's Cloudflare account, and nothing in this repo gives access to them. The admin token stays in `.proofprobe/`, which is never committed. Profile passwords are encrypted in the database, and the master password is stored only as a salted hash. The Worker holds only a hash of the token, as a Cloudflare secret.

To run your own copy, replace `account_id` and `database_id` in `wrangler.jsonc` with your own.

## License

MIT
