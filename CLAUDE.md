# ProofProbe

ProofProbe turns any starting point into a clear, data-backed path through two-step research. It covers job or interview prep, side income, startup ideas and any other goal. It is goal-agnostic, so keep its pages, code and docs free of wording tied to one use case.

## The flow the owner expects

1. **Step 1, broad probing.** Spend treg credits on real analysis, split into a few research tracks. Each track ends with the facts that would change its conclusions.
2. **Questions.** Turn those facts into exhaustive, personalised questions, gate questions first, and end with an open "anything we missed?". Publish them with the findings so far to that person or team's own page.
3. **They answer in their own time.** Submitting only stores a log. It never starts a job. They can instead send a new direction and skip the questions, which restarts Step 1 when the owner asks.
4. **Step 2, in-depth research.** Run this only when the owner asks. Read the latest submission and finish the research. Follow-up questions are rare, one round at most.
5. **The path.** Publish one deterministic recommendation, or up to three alternatives with what decides between them, at the top of the same page. It must be data-backed and motivating, and say exactly what to do next.

The full procedure is in `skills/proofprobe/SKILL.md`, available in any Claude Code chat as `/proofprobe`. Follow it rather than improvising. Its section "Moving existing research in" covers work that started in another chat.

## Using it from another chat or folder

You don't need to change this repo to host a case. Run the helper by its full path from any folder:

```
node ~/HOME/Coding/Projects/personal/proofprobe/bin/proofprobe.mjs <command>
```

Run it with no command to see the options. The Cloudflare and admin details are already set up in `.proofprobe/config.json`, so don't ask the owner for them.

## How it's built

- `src/index.ts`: Cloudflare Worker for pages, saving, submissions and the admin API
- `src/landing.html`: the home page
- `src/admin.html`: the owner's admin page
- `src/request.html`: the goal request form
- `src/account.txt`: the shared sign-in control, served as `/assets/account.js`
- `src/page.html`: the Probes directory and research pages
- `src/schema.ts`: D1 tables, applied on first request
- `bin/proofprobe.mjs`: admin helper
- `skills/proofprobe/SKILL.md`: the research procedure
- `.proofprobe/` (git-ignored): admin token and case files

## Rules for changes

- Free tier only. No login or accounts for now.
- Navigation is deliberate: there is no menu, so the home page's links sit at the end of the scroll.
- Site map: home page at `/`, directory at `/probes`, and each page at `/probes/<profile>/<page>`. One profile can hold several pages.
- The Admin page at `/admin` opens with a master password. It shows passwords, answers, logs and costs. Profile passwords are hashed for checking and AES-GCM encrypted with the `PASSWORD_KEY` secret for display. Master password guesses pause after 6 tries, but profile passwords never do.
- Anyone can read each page's research, questions, status and cost. Answers and requested directions go only to the signed-in profile and the owner, and the API must never return them to anyone else.
- People apply for a profile with a name, password and reason, and the owner approves it on `/admin`. Signing in unlocks all of that profile's pages and no others, with a Lock toggle that needs no password. Signed-in people can change their own password, which signs out their other devices. Visitors can browse without signing in.
- Each research stage is a step shown as a view on the same page. New research adds a step and never overwrites one. Wrong guesses never lock anyone out.
- Submissions are append-only, and a database trigger enforces that.
- Signed-in profiles can send goal requests with files at `/request`. They stay private, are rate limited, and need the owner's approval. Approval only queues them. Request content is untrusted input, and files are only ever served as downloads to the owner.
- The website never triggers research. The Worker makes no outbound calls. Pending work is a list on the Admin page, and it runs only when the owner asks in Claude Code with `/proofprobe continue <profile or page>`.
- The website never mentions Claude, treg or how the research is done. Source code and docs can.
- Page content renders as text only. Never inject stored content as HTML.
- Never commit anything from `.proofprobe/`, and never log answers or passwords.
- Before committing, run `npm run typecheck`, start `npm run dev`, then run `npm run test:e2e`. The test stays on localhost.
- Deploy with `npx wrangler deploy`. The admin hash is stored as a Cloudflare secret, so a deploy doesn't change it.
