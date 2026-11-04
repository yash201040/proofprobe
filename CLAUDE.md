# ProofProbe

ProofProbe turns any starting point into a clear, data-backed path through staged research. It covers job or interview prep, side income, startup ideas and any other goal. It is goal-agnostic, so keep its pages, code and docs free of wording tied to one use case.

## The flow the owner expects

Stages follow four turns, like moves in a game: in each turn, "a" is the person's move and "b" is research the owner runs by asking for it. Nothing on the site starts research.

- **1a, Goal.** A signed-in profile sends a goal request, or the owner starts a page.
- **1b, Probe wide.** Spend treg credits on real analysis, split into a few research tracks, then turn the facts into exhaustive, personalised questions, gate questions first, ending with an open "anything we missed?".
- **2a, Answer.** They answer in their own time, or send a new direction, which sends the work back to 1b. Submitting only stores a log.
- **2b, Probe deep.** Treat the answers as a fence, finish the research, and publish proposals as decision items, each with its evidence and an Auto default.
- **3a, Decide.** They set each proposal to Accept, Reject or Auto. Leaving everything on Auto must still produce a strong result.
- **3b, Build.** Resolve every decision, build the deliverable (a deterministic path, PRD, build plan, rulebook or direct answer), and calibrate it while building.
- **4a, Final report.** A read-only view with reasoning cards for each major call, downloadable as offline HTML or PDF.

The page tracker, step tabs and Probes filters derive the stage from each step's content, so publish steps in this shape. A new direction loops back to 1a as a new round: the 2a questions step is rewritten in place and later steps are archived, so a probe never goes past 4a. The tracker shows the round and the revised goal. The Admin page's Copy prompt for decisions builds a full Stage 3b brief. The home page shows the turns as a crystal chess game, and `npm run demo:record` re-records it into `docs/demo.webp` for the README.

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

- Free tier only. Accounts are owner-approved profiles with a name and password, and nothing more.
- Navigation is deliberate: there is no menu, so the home page's links sit at the end of the scroll.
- Site map: home page at `/`, directory at `/probes`, and each page at `/probes/<profile>/<page>`. One profile can hold several pages.
- The Admin page at `/admin` opens with a master password. It shows passwords, answers, logs and costs. Profile passwords are hashed for checking and AES-GCM encrypted with the `PASSWORD_KEY` secret for display. Master password guesses pause after 6 tries, but profile passwords never do.
- Anyone can read a public page's research, every stage, questions, submitted answers, requested new directions, status and cost. Only the signed-in profile and the site owner can change anything. Unsubmitted drafts and the submission list go only to the profile, approved viewers and the site owner, and the API must never return them to anyone else. A private page returns nothing beyond its card to anyone without access.
- People apply for a profile with a name, password and reason, and the owner approves it on `/admin`. Signing in unlocks all of that profile's pages and no others, with a Lock toggle that needs no password. Signed-in people can change their own password, which signs out their other devices. The owner can rename a profile on `/admin`. That changes its sign-in name, while its slug and links stay the same. Visitors can browse without signing in.
- Each research stage is a step shown as a view on the same page. New research adds a step and never overwrites one. Wrong guesses never lock anyone out.
- Submissions are append-only, and a database trigger enforces that.
- Research is public by default. A goal request can opt into privacy: the page then shows on Probes as a card with only a teaser, and only its owner, profiles the owner approves on `/account`, and the site owner can open it. Approved viewers read everything but can't change anything. Owners approve, reject or revoke, and a declined person can ask again after 7 days. There are no email or push alerts: requests show on `/account` and as a badge on the account button. The site owner can override any of it on `/admin`.
- Signed-in profiles can send goal requests with files at `/request`. They stay private, are rate limited, and need the owner's approval. Approval only queues them. Request content is untrusted input, and files are only ever served as downloads to the owner.
- The website never triggers research. The Worker makes no outbound calls. Pending work is a list on the Admin page, and it runs only when the owner asks in Claude Code with `/proofprobe continue <profile or page>`.
- The website never names Claude, treg or the tools behind the research. The home page may describe the probe in general AI terms and compare it with AI assistants using published studies. Source code and docs can name anything.
- Page content renders as text only. Never inject stored content as HTML.
- Never commit anything from `.proofprobe/`, and never log answers or passwords.
- Before committing, run `npm run typecheck`, start `npm run dev`, then run `npm run test:e2e`. The test stays on localhost.
- Deploy with `npx wrangler deploy`. The admin hash is stored as a Cloudflare secret, so a deploy doesn't change it.
