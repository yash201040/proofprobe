# Knowledge Gap

Turns someone's LinkedIn or CV plus a goal (a job description, an interview, or an open question) into researched questions, a shareable answer page, and a study plan with the least resistance to that goal.

- **`/gap` skill** (`skills/gap/SKILL.md`): runs in Claude Code. Opus does the thinking and treg does the live research, so the server needs no AI key.
- **Worker** (`src/`): hosts each case at a private link. No sign-in. People save and submit answers, and the plan appears on the same page.
- **`bin/gap.mjs`**: admin helper to create, publish, check and fetch cases.

## Setup

```
npm install
node bin/gap.mjs init --url https://<worker-url>
ln -s "$PWD/skills/gap" ~/.claude/skills/gap
npx wrangler deploy --var ADMIN_TOKEN_SHA256:<hash printed by init>
```

Local run: put `ADMIN_TOKEN_SHA256=<hash>` in `.dev.vars`, run `npm run dev`, then `npm run test:e2e`.

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
