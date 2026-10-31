#!/usr/bin/env node
// Admin helper for ProofProbe. Config and case links stay in .proofprobe/ (git-ignored).
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { randomBytes, createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CFG = process.env.GAP_CONFIG ?? join(ROOT, ".proofprobe/config.json");
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
const flag = (a, name) => { const i = a.indexOf("--" + name); return i >= 0 ? a[i + 1] : undefined; };
const [cmd, ...a] = process.argv.slice(2);
const out = (x) => console.log(JSON.stringify(x, null, 2));
switch (cmd) {
  case "init": {
    const c = existsSync(CFG) ? cfg() : { adminToken: randomBytes(32).toString("base64url"), baseUrl: "http://localhost:8799", links: {} };
    if (flag(a, "url")) {
      const next = flag(a, "url").replace(/\/$/, "");
      for (const id of Object.keys(c.links)) c.links[id] = c.links[id].replace(c.baseUrl, next);
      c.baseUrl = next;
    }
    saveCfg(c);
    console.log("ADMIN_TOKEN_SHA256=" + createHash("sha256").update(c.adminToken).digest("hex"));
    console.log("baseUrl=" + c.baseUrl);
    break;
  }
  case "new": {
    const r = await api("POST", "/cases", { title: flag(a, "title"), firstName: flag(a, "name") });
    const c = cfg(); c.links[r.id] = c.baseUrl + "/c/" + r.token; saveCfg(c);
    mkdirSync(join(ROOT, ".proofprobe/cases", r.id), { recursive: true });
    out({ id: r.id, link: c.links[r.id], folder: join(ROOT, ".proofprobe/cases", r.id) });
    break;
  }
  case "publish": {
    const body = {};
    if (flag(a, "intro")) body.intro = readJson(flag(a, "intro"));
    if (flag(a, "questions")) {
      body.questions = readJson(flag(a, "questions"));
      const qs = body.questions.flatMap((s) => s.questions);
      if (!qs.length || !qs[qs.length - 1].catchAll) throw new Error('the last question must be an open "anything we missed?" with "catchAll": true');
      const existing = (await api("GET", "/cases/" + a[0])).sections.flatMap((s) => s.questions.map((q) => q.id));
      const kept = new Set(qs.map((q) => q.id));
      const dropped = existing.filter((id) => !kept.has(id));
      if (dropped.length && !a.includes("--allow-drop")) throw new Error(`this would drop questions ${dropped.join(", ")}. Publish the full list, or pass --allow-drop`);
    }
    if (flag(a, "plan")) body.plan = readJson(flag(a, "plan"));
    if (flag(a, "status")) body.status = flag(a, "status");
    out(await api("PATCH", "/cases/" + a[0], body));
    console.log("link: " + cfg().links[a[0]]);
    break;
  }
  case "cost": out(await api("POST", `/cases/${a[0]}/costs`, { usd: Number(a[1]), label: a.slice(2).join(" ") || "research" })); break;
  case "rotate": {
    const r = await api("POST", `/cases/${a[0]}/rotate`);
    const c = cfg(); c.links[a[0]] = c.baseUrl + "/c/" + r.token; saveCfg(c);
    console.log("new link: " + c.links[a[0]] + "\nThe old link has stopped working.");
    break;
  }
  case "list": out(await api("GET", "/cases")); break;
  case "link": console.log(cfg().links[a[0]] ?? "no local link for this case"); break;
  case "status": {
    const r = await api("GET", "/cases/" + a[0]);
    const total = r.sections.flatMap((s) => s.questions).length;
    out({ id: r.id, title: r.title, status: r.status, questions: total, savedAnswers: Object.values(r.answers).filter((x) => x.text.trim()).length, submissions: r.submissions });
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
  default: console.log("proofprobe init [--url U] | new --name N --title T | cost ID USD [label] | rotate ID | publish ID [--intro F] [--questions F] [--plan F] [--status S] [--allow-drop] | list | link ID | status ID | fetch ID [--seq N] [--out F] | purge ID");
}
