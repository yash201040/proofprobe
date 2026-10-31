#!/usr/bin/env node
// Admin helper for ProofProbe. Config and case links stay in .proofprobe/ (git-ignored).
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
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
const out = (x) => console.log(JSON.stringify(x, null, 2));
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
    const res = await fetch(c.baseUrl + "/admin/cases", { method: "POST", headers: { Authorization: "Bearer " + c.adminToken, "Content-Type": "application/json" }, body: JSON.stringify({ title: flag(a, "title"), profile, create: a.includes("--new-profile") }) });
    const r = await res.json();
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
    if (step) body.step = Number(step);
    if (flag(a, "intro")) body.intro = readJson(flag(a, "intro"));
    if (flag(a, "plan")) body.plan = readJson(flag(a, "plan"));
    if (flag(a, "status")) body.status = flag(a, "status");
    if (flag(a, "questions")) {
      body.questions = readJson(flag(a, "questions"));
      const qs = body.questions.flatMap((s) => s.questions);
      if (!qs.length || !qs[qs.length - 1].catchAll) throw new Error('the last question must be an open "anything we missed?" with "catchAll": true');
      if (!newStep) {
        const r = await api("GET", "/cases/" + a[0]);
        const target = r.steps.find((s) => s.n === (step ? Number(step) : r.steps[r.steps.length - 1].n));
        const existing = (target?.sections ?? []).flatMap((s) => s.questions.map((q) => q.id));
        const kept = new Set(qs.map((q) => q.id)), dropped = existing.filter((id) => !kept.has(id));
        if (dropped.length && !a.includes("--allow-drop")) throw new Error(`this would drop questions ${dropped.join(", ")}. Publish the full list, or pass --allow-drop`);
      }
    }
    const c = cfg(), res = await fetch(`${c.baseUrl}/admin/cases/${a[0]}`, { method: "PATCH", headers: { Authorization: "Bearer " + c.adminToken, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const r = await res.json();
    if (r.error === "use_new_step") { console.error('This step already has responses, or a new direction is waiting. Add the new work with --new-step "Title". To correct existing content, use --step N.'); process.exit(1); }
    if (!res.ok) throw new Error(`publish: ${res.status} ${JSON.stringify(r)}`);
    console.log("published");
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
    out({ id: r.id, title: r.title, status: r.status, reroute: r.reroute, submissionCurrent: r.submissionCurrent, steps: r.steps.map((s) => `${s.n}: ${s.title}`), questions: total, savedAnswers: Object.values(r.answers).filter((x) => x.text.trim()).length, submissions: r.submissions });
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
  default: console.log("proofprobe init [--url U] | new --profile NAME --title T [--new-profile] | profiles | pending | requests | request ID | approve ID | reject ID | request-started ID --case CASE | export ID | import ID --answers F | cost ID USD [label] | password ID [--set P] | admin-setup | publish ID [--intro F] [--questions F] [--plan F] [--status S] [--new-step TITLE | --step N] [--allow-drop] | list | link ID | status ID | fetch ID [--seq N] [--out F] | purge ID");
}
