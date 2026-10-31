# Knowledge Gap

Two-step research that turns any starting point into a clear, data-backed path: a job or interview to prepare for, a search for side income, a startup idea, or another goal.

1. **Broad probing:** research the goal, then publish exhaustive personalised questions.
2. **In-depth research:** when asked, read the latest submission and publish the path on the same page, as one recommendation or up to three alternatives.

- **`/gap` skill** (`skills/gap/SKILL.md`): runs in Claude Code. Opus does the thinking and treg does the live research, so the server needs no AI key.
- **Worker** (`src/`): hosts each case at a private link. No sign-in. People save and submit answers, and the plan appears on the same page.
- **`bin/gap.mjs`**: admin helper to create, publish, check and fetch cases.

## Setup

```
npm install
node bin/gap.mjs init --url https://<worker-url>
ln -s "$PWD/skills/gap" ~/.claude/skills/gap
npx wrangler login
npx wrangler secret put ADMIN_TOKEN_SHA256     # paste the hash printed by init
npx wrangler deploy
```

Local test: put `ADMIN_TOKEN_SHA256=<hash>` in `.dev.vars`, run `npm run dev`, then `npm run test:e2e`. The test only ever talks to localhost. `npm run typecheck` checks the Worker.

## Data rules

- Sharing: send each person their own link. There is no login, password or email. A closed friend group can read every page and submitted answers, and a notice says so. Only a person's own link can change their answers.
- Submitting stores a log and starts nothing. Research continues only when `/gap` is run.
- The cost shown on a page is treg data spend logged with `gap cost`. Claude usage is not included.
- Submissions are append-only. A database trigger blocks updates, and each log stores a SHA-256 so corruption is detectable.
- Page content is rendered as text only, so stored content cannot inject markup.
- CVs and research notes stay in `.gap/` on this machine, which git ignores. Only questions, intro, plan and costs go to the server.
- Answer text and tokens are never logged.

## Platform guide deviations

This is a tiny free-tier app, so it follows the guide's rule that tiny apps stay on D1. It skips Postgres, Hyperdrive, WorkOS and PostHog, which need paid plans or sign-in. It keeps `audit_log`, idempotency keys, structured logs with `ray_id`, access decisions in the Worker, and walls over conventions. D1 exports to Postgres through the guide's pgloader recipe if this outgrows it. The schema is applied on first request rather than through CLI migrations, because temporary accounts could not run them.
