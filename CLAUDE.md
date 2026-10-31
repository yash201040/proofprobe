# ProofProbe

ProofProbe turns any starting point into a clear, data-backed path through two-step research. It covers job or interview prep, side income, startup ideas and any other goal. It is goal-agnostic, so keep its pages, code and docs free of wording tied to one use case.

## The flow the owner expects

1. **Step 1, broad probing.** Spend treg credits on real analysis, split into a few research tracks. Each track ends with the facts that would change its conclusions.
2. **Questions.** Turn those facts into exhaustive, personalised questions, gate questions first, and end with an open "anything we missed?". Publish them with the findings so far to that person or team's own page.
3. **They answer in their own time.** Submitting only stores a log. It never starts a job.
4. **Step 2, in-depth research.** Run this only when the owner asks. Read the latest submission and finish the research. Follow-up questions are rare, one round at most.
5. **The path.** Publish one deterministic recommendation, or up to three alternatives with what decides between them, at the top of the same page. It must be data-backed and motivating, and say exactly what to do next.

The full procedure is in `skills/proofprobe/SKILL.md`, available in any Claude Code chat as `/proofprobe`. Follow it rather than improvising. Its section "Moving existing research in" covers work that started in another chat.

## Using it from another chat or folder

You don't need to change this repo to host a case. Run the helper by its full path from any folder:

```
node /Users/guts/HOME/Coding/Projects/personal/proofprobe/bin/proofprobe.mjs <command>
```

Run it with no command to see the options. The Cloudflare and admin details are already set up in `.proofprobe/config.json`, so don't ask the owner for them.

## How it's built

- `src/index.ts`: Cloudflare Worker for pages, saving, submissions and the admin API
- `src/page.html`: the single page people use
- `src/schema.ts`: D1 tables, applied on first request
- `bin/proofprobe.mjs`: admin helper
- `skills/proofprobe/SKILL.md`: the research procedure
- `.proofprobe/` (git-ignored): admin token, personal links, and case files

## Rules for changes

- Free tier only. No login or accounts for now.
- Each person or team has one private link. Only that link can change its answers. The group can read every page and submitted answers, and a page notice says so.
- Submissions are append-only, and a database trigger enforces that.
- Page content renders as text only. Never inject stored content as HTML.
- Never commit anything from `.proofprobe/`, and never log answers or links.
- Before committing, run `npm run typecheck`, start `npm run dev`, then run `npm run test:e2e`. The test stays on localhost.
- Deploy with `npx wrangler deploy`. The admin hash is stored as a Cloudflare secret, so a deploy doesn't change it.
