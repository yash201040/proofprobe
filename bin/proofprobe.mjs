#!/usr/bin/env node
// Admin helper for ProofProbe. Config and case links stay in .proofprobe/ (git-ignored).
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CFG = process.env.PROOFPROBE_CONFIG ?? join(ROOT, ".proofprobe/config.json");
const cfg = () => { if (!existsSync(CFG)) throw new Error("run: proofprobe init"); return JSON.parse(readFileSync(CFG, "utf8")); };
const saveCfg = (c) => { mkdirSync(dirname(CFG), { recursive: true }); writeFileSync(CFG, JSON.stringify(c, null, 2)); chmodSync(CFG, 0o600); };
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
async function api(method, path, body) {
  const c = cfg();
  const r = await fetch(c.baseUrl + "/admin" + path, { method, headers: { Authorization: "Bearer " + c.adminToken, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${text.slice(0, 200)}`);
  return JSON.parse(text);
}
const WORDS = "amber birch cedar delta ember fable glade harbor indigo juniper kestrel lumen meadow nectar orbit pebble quartz river summit tundra umber velvet willow zephyr".split(" ");
const newPassword = () => { const b = randomBytes(5); return `${WORDS[b[0] % 24]}-${WORDS[b[1] % 24]}-${WORDS[b[2] % 24]}-${(b.readUInt16BE(3) % 9000) + 1000}`; };
const flag = (a, name) => { const i = a.indexOf("--" + name); return i >= 0 ? a[i + 1] : undefined; };
const [cmd, ...a] = process.argv.slice(2);
process.on("uncaughtException", (e) => { console.error("proofprobe: " + e.message); process.exit(1); });
const out = (x) => console.log(JSON.stringify(x, null, 2));

// Research calls: tools.json says which treg tools each stage may use; every call is capped and logged per case.
const TOOLS = join(ROOT, "skills/proofprobe/tools.json");
const caseDir = (id) => { if (!/^[a-z0-9-]+$/i.test(id ?? "")) throw new Error("give the page id first"); return join(ROOT, ".proofprobe/cases", id); };
const callLog = (id) => { const f = join(caseDir(id), "calls.jsonl"); return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []; };
const usd = (micro) => "$" + (micro / 1e6).toFixed(4);
function stageTools(stage) {
  const t = readJson(TOOLS), groups = t.stages[stage];
  if (!groups) throw new Error(`stage must be one of: ${Object.keys(t.stages).join(", ")}`);
  const tools = new Map();
  for (const g of groups) for (const tool of t.groups[g].tools) if (!tools.has(tool.id)) tools.set(tool.id, { ...tool, group: g, cap: t.groups[g].maxCostUsd ?? t.maxCostUsd });
  return { t, groups, tools };
}
const flags = (list, name) => list.flatMap((x, i) => (list[i - 1] === "--" + name ? [x] : []));
const NEVER = /(^|\.)(video-gen|image-gen|voice-gen|music-gen|ai-search)\.|[.-](create|delete|update|send|publish|reply|bookmark)([.-]|$)/;
switch (cmd) {
  case "init": {
    const c = existsSync(CFG) ? cfg() : { adminToken: randomBytes(32).toString("base64url"), baseUrl: "http://localhost:8799" };
    if (flag(a, "url")) {
      const next = flag(a, "url").replace(/\/$/, "");
      c.baseUrl = next;
    }
    saveCfg(c);
    console.log("ADMIN_TOKEN_SHA256=" + createHash("sha256").update(c.adminToken).digest("hex"));
    console.log("baseUrl=" + c.baseUrl);
    break;
  }
  case "new": {
    const c = cfg(), profile = flag(a, "profile");
    const res = await fetch(c.baseUrl + "/admin/cases", { method: "POST", headers: { Authorization: "Bearer " + c.adminToken, "Content-Type": "application/json" }, body: JSON.stringify({ title: flag(a, "title"), profile, create: a.includes("--new-profile"), private: a.includes("--private"), teaser: flag(a, "teaser") ?? undefined, requestId: flag(a, "request") ?? undefined }) });
    const r = await res.json();
    if (r.error === "request_mismatch") { console.error("That request belongs to a different profile, or doesn't exist. Check the request id and profile name."); process.exit(1); }
    if (res.status === 404 && r.error === "unknown_profile") {
      console.error(`No profile named "${profile}". Existing profiles: ${r.profiles.join(", ") || "none"}.\nUse one of those exact names, or add --new-profile if this is a new person.`);
      process.exit(1);
    }
    if (!res.ok) throw new Error(`new: ${res.status} ${JSON.stringify(r)}`);
    mkdirSync(join(dirname(CFG), "cases", r.id), { recursive: true });
    out({ id: r.id, profile: r.profile, profileCreated: r.profileCreated, link: c.baseUrl + r.path, folder: join(dirname(CFG), "cases", r.id) });
    break;
  }
  case "publish": {
    const body = {}, newStep = flag(a, "new-step"), step = flag(a, "step");
    if (newStep) body.newStep = newStep;
    if (a.includes("--new-round")) body.newRound = true;
    if (step) body.step = Number(step);
    if (flag(a, "title")) body.stepTitle = flag(a, "title");
    if (flag(a, "intro")) body.intro = readJson(flag(a, "intro"));
    if (flag(a, "plan")) body.plan = readJson(flag(a, "plan"));
    if (flag(a, "status")) body.status = flag(a, "status");
    if (flag(a, "questions")) {
      body.questions = readJson(flag(a, "questions"));
      const qs = body.questions.flatMap((s) => s.questions);
      if (!qs.length || !qs[qs.length - 1].catchAll) throw new Error('the last question must be an open "anything we missed?" with "catchAll": true');
      if (!newStep && !a.includes("--new-round")) {
        const r = await api("GET", "/cases/" + a[0]), latestN = r.steps[r.steps.length - 1].n;
        // A waiting direction starts a new round, and answered questions move to the next stage, so neither drops anything.
        const advances = !step && (r.reroute || r.submissions.some((s) => s.stepN === latestN && s.round === r.round));
        const target = r.steps.find((s) => s.n === (step ? Number(step) : r.steps[r.steps.length - 1].n));
        const existing = (target?.sections ?? []).flatMap((s) => s.questions.map((q) => q.id));
        const kept = new Set(qs.map((q) => q.id)), dropped = existing.filter((id) => !kept.has(id));
        if (!advances && dropped.length && !a.includes("--allow-drop")) throw new Error(`this would drop questions ${dropped.join(", ")}. Publish the full list, or pass --allow-drop`);
      }
    }
    const c = cfg(), res = await fetch(`${c.baseUrl}/admin/cases/${a[0]}`, { method: "PATCH", headers: { Authorization: "Bearer " + c.adminToken, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const r = await res.json();
    if (r.error === "use_new_round" || r.error === "reroute_waiting") { console.error("A new direction is waiting. Publish fresh questions (--questions) for it, which repeats the round from 2a."); process.exit(1); }
    if (r.error === "stage_order") { console.error("Stages only move forward: questions (2a), then decisions (3a), then the final report (4a). To change an existing step, use --step N."); process.exit(1); }
    if (r.error === "use_new_step") { console.error("This step already has submitted answers, so it can't be overwritten. Publish the next stage instead, or correct a step with --step N."); process.exit(1); }
    if (!res.ok) throw new Error(`publish: ${res.status} ${JSON.stringify(r)}`);
    console.log(r.mode === "new_round" ? `published: started round ${r.round} from the new direction` : r.mode === "next_step" ? "published: added the next stage" : "published");
    console.log("link: " + c.baseUrl + (await api("GET", "/cases/" + a[0])).path);
    break;
  }
  case "cost": out(await api("POST", `/cases/${a[0]}/costs`, { usd: Number(a[1]), label: a.slice(2).join(" ") || "research" })); break;
  case "password": {
    const pw = flag(a, "set") ?? newPassword();
    await api("POST", `/cases/${a[0]}/password`, { password: pw });
    console.log(`Password set. The owner can see it on the Admin page.${flag(a, "set") ? "" : `\npassword: ${pw}`}`);
    break;
  }
  case "admin-setup": {
    const r = await api("POST", "/setup-code");
    console.log(`Open this one-time link within 30 minutes to choose the master password:\n${cfg().baseUrl}/admin#setup=${r.code}`);
    break;
  }
  case "export": {
    const r = await api("GET", "/cases/" + a[0]);
    for (const s of r.steps) {
      const dir = join(dirname(CFG), "cases", a[0], "step-" + s.n);
      mkdirSync(dir, { recursive: true });
      for (const [name, value] of [["intro", s.intro], ["plan", s.plan], ["questions", s.sections]]) writeFileSync(join(dir, name + ".json"), JSON.stringify(value, null, 2));
    }
    console.log(`Saved ${r.steps.length} step(s) to ${join(dirname(CFG), "cases", a[0])}/step-N`);
    break;
  }
  case "approve-profile": out(await api("POST", `/profiles/${encodeURIComponent(a.join(" "))}/approve`)); break;
  case "reject-profile": out(await api("POST", `/profiles/${encodeURIComponent(a.join(" "))}/reject`)); break;
  case "requests": out((await api("GET", "/requests")).requests); break;
  case "request": {
    const r = await api("GET", "/requests/" + a[0]);
    const c = cfg(), dir = join(dirname(CFG), "requests", a[0]);
    mkdirSync(dir, { recursive: true });
    const saved = [];
    for (const f of r.files) {
      const res = await fetch(`${c.baseUrl}/admin/requests/${a[0]}/files/${f.id}`, { headers: { Authorization: "Bearer " + c.adminToken } });
      if (!res.ok) throw new Error(`file ${f.name}: ${res.status}`);
      const path = join(dir, `${f.id}-${f.name.replace(/[^\w.-]+/g, "_")}`);
      writeFileSync(path, Buffer.from(await res.arrayBuffer()));
      saved.push(path);
    }
    out({ ...r, files: saved });
    break;
  }
  case "approve": out(await api("POST", "/requests/" + a[0], { status: "approved" })); break;
  case "reject": out(await api("POST", "/requests/" + a[0], { status: "rejected" })); break;
  case "privacy": {
    const mode = a[1];
    if (mode !== "private" && mode !== "public") throw new Error("usage: privacy ID private|public [--teaser T]");
    const c = cfg(), res = await fetch(`${c.baseUrl}/admin/cases/${a[0]}`, { method: "PATCH", headers: { Authorization: "Bearer " + c.adminToken, "Content-Type": "application/json" }, body: JSON.stringify({ private: mode === "private", teaser: flag(a, "teaser") ?? undefined }) });
    if (!res.ok) throw new Error(`privacy: ${res.status} ${await res.text()}`);
    const done = await res.json(); out({ ok: true, id: a[0], private: mode === "private", link: done.path ? c.baseUrl + done.path : null }); break;
  }
  case "request-started": out(await api("POST", "/requests/" + a[0], { status: "started", caseId: flag(a, "case") })); break;
  case "pending": out((await api("GET", "/pending")).pending); break;
  case "profiles": out(await api("GET", "/profiles")); break;
  case "import": {
    out(await api("POST", `/cases/${a[0]}/import`, { answers: readJson(flag(a, "answers")) }));
    break;
  }
  case "list": out(await api("GET", "/cases")); break;
  case "link": console.log(cfg().baseUrl + (await api("GET", "/cases/" + a[0])).path); break;
  case "status": {
    const r = await api("GET", "/cases/" + a[0]);
    const total = r.sections.flatMap((s) => s.questions).length;
    out({ id: r.id, title: r.title, status: r.status, reroute: r.reroute, round: r.round, archivedRounds: r.archivedRounds, submissionCurrent: r.submissionCurrent, steps: r.steps.map((s) => `${s.n}: ${s.title}`), questions: total, savedAnswers: Object.values(r.answers).filter((x) => x.text.trim()).length, submissions: r.submissions });
    break;
  }
  case "fetch": {
    const which = flag(a, "seq") ?? "latest";
    const r = await api("GET", `/cases/${a[0]}/submissions/${which}`);
    const file = flag(a, "out");
    if (file) { writeFileSync(file, JSON.stringify(r, null, 2)); console.log(`seq ${r.seq}, intact ${r.intact}, ${r.answered}/${r.total} answered, saved to ${file}`); } else out(r);
    break;
  }
  case "purge": out(await api("DELETE", "/cases/" + a[0])); break;
  case "tools": {
    const t = readJson(TOOLS), stages = a[0] ? [a[0]] : Object.keys(t.stages);
    for (const s of stages) {
      const { groups } = stageTools(s);
      console.log(`\nStage ${s}: budget $${t.budgetsUsd[s]}, each call capped at $${t.maxCostUsd} unless a group says otherwise`);
      for (const g of groups) {
        const grp = t.groups[g];
        console.log(`\n  ${g}${grp.maxCostUsd ? ` (cap $${grp.maxCostUsd})` : ""}: ${grp.use}`);
        for (const x of grp.tools) console.log(`    ${x.id.padEnd(44)} ${x.price.padEnd(22)} ${x.job}\n      ${x.send ? "body " + x.send : "query " + x.query}`);
      }
    }
    console.log("\nNever:\n" + t.neverUse.map((x) => "  - " + x).join("\n") + "\n\nOff the list: " + t.offList);
    break;
  }
  case "call": {
    // proofprobe call <page id> <stage> <tool> [json body | @file] [--query k=v]... [--track T] [--why W] [--max-cost USD] [--out F] [--over-budget]
    const [id, stage, tool] = a, body = a[3] && !a[3].startsWith("--") ? a[3] : undefined;
    if (!tool) throw new Error("usage: proofprobe call <page id> <stage> <tool> [json body | @file] [--query k=v] [--track T] [--why W] [--max-cost USD] [--out F] [--over-budget]");
    const dir = caseDir(id), { t, tools } = stageTools(stage), listed = tools.get(tool), why = flag(a, "why");
    if (NEVER.test(tool)) throw new Error(`${tool} is never used for research (generation, asking another assistant, or writing to an account). See \`proofprobe tools\`.`);
    if (!listed && !why) throw new Error(`${tool} is not on the Stage ${stage} list. Use a listed tool (\`proofprobe tools ${stage}\`), or add --why "<the question only it answers>".`);
    const log = callLog(id), spent = log.filter((x) => x.stage === stage).reduce((n, x) => n + (x.chargedMicro || 0), 0), budget = t.budgetsUsd[stage] * 1e6;
    if (spent >= budget && !a.includes("--over-budget")) throw new Error(`Stage ${stage} of ${id} has spent ${usd(spent)} of its $${t.budgetsUsd[stage]} budget. Ask the user first, then add --over-budget.`);
    const cap = Number(flag(a, "max-cost") ?? listed?.cap ?? t.maxCostUsd);
    const args = ["--json", "call", tool, "--header", `X-Treg-Route-Max-Cost: ${cap}`];
    if (t.prefer[tool]) args.push("--header", `X-Treg-Route-Prefer: ${t.prefer[tool]}`);
    if (body) args.push("--data", body);
    for (const q of flags(a, "query")) args.push("--query", q);
    const run = spawnSync("treg", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    if (run.error) throw new Error("treg is not installed or not on PATH: " + run.error.message);
    let res;
    try { res = JSON.parse(run.stdout); } catch { throw new Error("treg answered something other than JSON: " + (run.stdout || run.stderr).slice(0, 400)); }
    const meta = res._treg ?? {}, route = res.result?._treg ?? {};
    const entry = { at: new Date().toISOString(), stage, track: flag(a, "track") ?? "", tool, offList: !listed, why: why ?? "", http: meta.http_status, callId: meta.call_id, chargedMicro: meta.charged_micro ?? 0, servedBy: route.served_by ?? tool, outcome: route.outcome ?? (meta.http_status < 400 ? "ok" : "error"), tried: route.tried?.length ?? 1 };
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "calls.jsonl"), JSON.stringify(entry) + "\n");
    const file = flag(a, "out");
    if (file) writeFileSync(file, JSON.stringify(res.result, null, 2)); else console.log(JSON.stringify(res.result));
    console.error(`proofprobe: ${tool} via ${entry.servedBy}, HTTP ${entry.http}, ${usd(entry.chargedMicro)}${entry.offList ? ", off-list" : ""}. Stage ${stage} spent ${usd(spent + entry.chargedMicro)} of $${t.budgetsUsd[stage]}.${file ? " Saved to " + file : ""}`);
    if (entry.http === 402) console.error("proofprobe: the treg balance cannot cover this call. Run `treg balance`, and ask the user to top up; free tools still work.");
    if (entry.http >= 400) process.exitCode = 1;
    break;
  }
  case "calls": {
    const id = a[0], only = flag(a, "stage"), log = callLog(id).filter((x) => !only || x.stage === only);
    if (!log.length) { console.log("No research calls logged for " + id + (only ? " in Stage " + only : "") + "."); break; }
    for (const stage of [...new Set(log.map((x) => x.stage))]) {
      const rows = log.filter((x) => x.stage === stage), total = rows.reduce((n, x) => n + x.chargedMicro, 0), byTool = new Map();
      for (const x of rows) { const r = byTool.get(x.tool) ?? { n: 0, ok: 0, micro: 0, served: new Set() }; r.n++; if (x.http < 400 && !["miss", "not_found"].includes(x.outcome)) r.ok++; r.micro += x.chargedMicro; r.served.add(x.servedBy); byTool.set(x.tool, r); }
      console.log(`\nStage ${stage}: ${rows.length} calls, ${usd(total)}`);
      for (const [tool, r] of [...byTool].sort((p, q) => q[1].micro - p[1].micro || q[1].n - p[1].n)) console.log(`  ${tool.padEnd(44)} ${String(r.n).padStart(3)} calls  ${String(r.ok).padStart(3)} useful  ${usd(r.micro).padStart(9)}  via ${[...r.served].join(", ")}`);
      for (const x of rows.filter((x) => x.offList)) console.log(`  off-list ${x.tool}: ${x.why}`);
      console.log(`  Record it: proofprobe cost ${id} ${(total / 1e6).toFixed(4)} "Stage ${stage} research"`);
    }
    break;
  }
  default: console.log("proofprobe init [--url U] | new --profile NAME --title T [--new-profile] [--request ID] [--private [--teaser T]] | privacy ID private|public [--teaser T] | profiles | pending | approve-profile NAME | reject-profile NAME | requests | request ID | approve ID | reject ID | request-started ID --case CASE | export ID | import ID --answers F | cost ID USD [label] | password ID [--set P] (sets the password of that page's whole profile and signs out its devices) | admin-setup | publish ID [--intro F] [--questions F] [--plan F] [--status S] [--step N] [--title T] (the stage is worked out: a waiting direction repeats the round, submitted answers move to the next stage) [--allow-drop] | list | link ID | status ID | fetch ID [--seq N] [--out F] | purge ID | tools [STAGE] | call ID STAGE TOOL [BODY|@F] [--query K=V] [--track T] [--why W] [--max-cost USD] [--out F] [--over-budget] | calls ID [--stage S]");
}
