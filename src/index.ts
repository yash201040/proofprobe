import APP from "./page.html";
import LANDING from "./landing.html";
import ADMIN from "./admin.html";
import { SCHEMA } from "./schema";

export interface Env { DB: D1Database; APP_VERSION: string; ADMIN_TOKEN_SHA256: string; PASSWORD_KEY: string }

const MAX_ANSWER = 30_000;
const MAX_DOC = 300_000;
const MAX_REROUTE = 5_000;
const SESSION_DAYS = 30;
const ADMIN_HOURS = 12;
const ADMIN_MAX_FAILS = 6;
const ADMIN_LOCK_MINUTES = 15;
const ADMIN_SESSION = "__admin";
const STATUSES = ["draft", "open", "submitted", "plan_ready", "closed"];
const TONES = ["good", "warn", "bad", "info"];

let schemaReady = false;

const SEC: Record<string, string> = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};
const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'";

const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...SEC, "Content-Type": "application/json; charset=utf-8", ...extra } });
const notFound = () => new Response("Not found", { status: 404, headers: { ...SEC, "Content-Type": "text/plain" } });
const html = (body: string, request: Request) =>
  new Response(request.method === "HEAD" ? null : body, { headers: { ...SEC, "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": CSP } });

async function sha256(text: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const randomToken = () => {
  const b = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const parse = <T,>(s: string, fallback: T): T => { try { return JSON.parse(s) as T; } catch { return fallback; } };
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "page";

// Field contract from the platform guide. Answer text, passwords and tokens are never logged.
function log(env: Env, ray: string, level: string, msg: string, extra: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ app: "proofprobe", version: env.APP_VERSION, ray_id: ray, level, msg, ...extra }));
}

interface Question { id: string; text: string; why?: string }
interface Section { title: string; note?: string; first?: boolean; questions: Question[] }
interface CaseRow {
  id: string; title: string; first_name: string; status: string; intro_json: string; questions_json: string; plan_json: string;
  created_at: string; updated_at: string; profile_id: string | null; slug: string | null;
  password_hash: string | null; password_salt: string | null; password_enc: string | null; password_iv: string | null;
}
interface ProfileRow { id: string; slug: string; name: string; password_hash: string | null; password_salt: string | null; password_enc: string | null; password_iv: string | null; pw_version: number }

async function freeSlug(env: Env, table: "profiles" | "cases", base: string, scope?: string) {
  for (let i = 1; ; i++) {
    const slug = i === 1 ? base : `${base}-${i}`;
    const hit = table === "profiles"
      ? await env.DB.prepare("SELECT 1 FROM profiles WHERE slug = ?").bind(slug).first()
      : await env.DB.prepare("SELECT 1 FROM cases WHERE profile_id = ? AND slug = ?").bind(scope!, slug).first();
    if (!hit) return slug;
  }
}
async function profileFor(env: Env, name: string, now: string) {
  const found = await env.DB.prepare("SELECT id, slug FROM profiles WHERE lower(name) = lower(?)").bind(name).first<{ id: string; slug: string }>();
  if (found) return found;
  const id = crypto.randomUUID().slice(0, 8), slug = await freeSlug(env, "profiles", slugify(name));
  await env.DB.prepare("INSERT INTO profiles(id, slug, name, created_at) VALUES (?,?,?,?)").bind(id, slug, name, now).run();
  return { id, slug };
}

// Columns added after the first release, plus a backfill for cases created before profiles existed.
async function migrate(env: Env) {
  await env.DB.batch(SCHEMA.map((q) => env.DB.prepare(q)));
  const cols = new Set((await env.DB.prepare("SELECT name FROM pragma_table_info('cases')").all()).results.map((r: any) => r.name));
  const add = [["profile_id", "TEXT"], ["slug", "TEXT"], ["password_hash", "TEXT"], ["password_salt", "TEXT"], ["pw_version", "INTEGER NOT NULL DEFAULT 0"], ["password_enc", "TEXT"], ["password_iv", "TEXT"]];
  for (const [name, type] of add) if (!cols.has(name)) await env.DB.prepare(`ALTER TABLE cases ADD COLUMN ${name} ${type}`).run();
  const pcols = new Set((await env.DB.prepare("SELECT name FROM pragma_table_info('profiles')").all()).results.map((r: any) => r.name));
  for (const [name, type] of [["password_hash", "TEXT"], ["password_salt", "TEXT"], ["password_enc", "TEXT"], ["password_iv", "TEXT"], ["pw_version", "INTEGER NOT NULL DEFAULT 0"]])
    if (!pcols.has(name)) await env.DB.prepare(`ALTER TABLE profiles ADD COLUMN ${name} ${type}`).run();
  const old = await env.DB.prepare("SELECT id, title, first_name FROM cases WHERE profile_id IS NULL OR slug IS NULL").all<any>();
  const now = new Date().toISOString();
  for (const c of old.results) {
    const p = await profileFor(env, c.first_name, now);
    await env.DB.prepare("UPDATE cases SET profile_id = ?, slug = ? WHERE id = ?").bind(p.id, await freeSlug(env, "cases", slugify(c.title), p.id), c.id).run();
  }
  // Passwords moved from pages to profiles. Carry each one up, then clear the page copy.
  const moved = await env.DB.prepare("SELECT id, profile_id, password_hash, password_salt, password_enc, password_iv FROM cases WHERE password_hash IS NOT NULL").all<any>();
  for (const c of moved.results) {
    await env.DB.batch([
      env.DB.prepare("UPDATE profiles SET password_hash = ?, password_salt = ?, password_enc = ?, password_iv = ?, pw_version = pw_version + 1 WHERE id = ? AND password_hash IS NULL").bind(c.password_hash, c.password_salt, c.password_enc, c.password_iv, c.profile_id),
      env.DB.prepare("UPDATE cases SET password_hash = NULL, password_salt = NULL, password_enc = NULL, password_iv = NULL WHERE id = ?").bind(c.id),
    ]);
  }
}

function flatten(sections: Section[]) {
  return sections.flatMap((s) => s.questions.map((q) => ({ id: q.id, section: s.title, question: q.text })));
}
function validSections(v: unknown): v is Section[] {
  if (!Array.isArray(v)) return false;
  const ids = new Set<string>();
  for (const s of v as Section[]) {
    if (typeof s?.title !== "string" || !Array.isArray(s.questions)) return false;
    for (const q of s.questions) {
      if (typeof q?.id !== "string" || !/^[\w-]{1,40}$/.test(q.id) || typeof q.text !== "string" || ids.has(q.id)) return false;
      ids.add(q.id);
    }
  }
  return true;
}
const isStrings = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string");
const isScore = (n: unknown) => n === undefined || (typeof n === "number" && Number.isFinite(n) && n >= 0);
const isCell = (c: any) => typeof c === "string" || (typeof c?.text === "string" && (c.tone === undefined || TONES.includes(c.tone)) && isScore(c.score) && isScore(c.max));
function validBlock(b: any): boolean {
  if (b?.t === "section") return typeof b.title === "string" && Array.isArray(b.blocks) && b.blocks.every(validBlock);
  if (["h2", "h3", "p", "callout"].includes(b?.t)) return typeof b.text === "string";
  if (b?.t === "ul" || b?.t === "ol") return isStrings(b.items);
  if (b?.t === "bars") return typeof b.title === "string" && isScore(b.max) && Array.isArray(b.items) && b.items.every((i: any) => typeof i?.label === "string" && typeof i.value === "number" && isScore(i.value));
  if (b?.t === "table") return isStrings(b.head) && Array.isArray(b.rows) && b.rows.every((r: unknown) => Array.isArray(r) && r.every(isCell));
  if (b?.t === "links") return Array.isArray(b.links) && b.links.every((k: any) => typeof k?.url === "string");
  return false;
}
const validBlocks = (v: unknown) => Array.isArray(v) && v.every(validBlock);

const openReroute = (env: Env, caseId: string) =>
  env.DB.prepare("SELECT message, at FROM reroutes WHERE case_id = ? AND handled_at IS NULL ORDER BY id DESC LIMIT 1").bind(caseId).first<{ message: string; at: string }>();
async function costUsd(env: Env, caseId: string) {
  const r = await env.DB.prepare("SELECT COALESCE(SUM(usd_micro), 0) AS micro FROM cost_entries WHERE case_id = ?").bind(caseId).first<{ micro: number }>();
  return (r?.micro ?? 0) / 1_000_000;
}
async function summaries(env: Env, caseId: string) {
  const r = await env.DB.prepare("SELECT seq, submitted_at, answered, total, changed_json FROM submissions WHERE case_id = ? ORDER BY seq").bind(caseId).all();
  return r.results.map((x: any) => ({ seq: x.seq, submittedAt: x.submitted_at, answered: x.answered, total: x.total, changed: parse(x.changed_json, []) }));
}
async function currentAnswers(env: Env, caseId: string) {
  const r = await env.DB.prepare("SELECT question_id, text, updated_at FROM answers WHERE case_id = ?").bind(caseId).all();
  const out: Record<string, { text: string; updatedAt: string }> = {};
  for (const x of r.results as any[]) out[x.question_id] = { text: x.text, updatedAt: x.updated_at };
  return out;
}
const audit = (env: Env, caseId: string | null, actor: string, action: string, detail: string | null, ray: string) =>
  env.DB.prepare("INSERT INTO audit_log(case_id, actor, action, detail, ray_id, at) VALUES (?,?,?,?,?,?)").bind(caseId, actor, action, detail, ray, new Date().toISOString());

const cookieName = (profileId: string) => `pp_edit_${profileId}`;
function readCookie(request: Request, name: string) {
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}
const profileOf = (env: Env, id: string | null) => env.DB.prepare("SELECT * FROM profiles WHERE id = ?").bind(id).first<ProfileRow>();
async function canEdit(request: Request, env: Env, profile: ProfileRow) {
  const token = readCookie(request, cookieName(profile.id));
  if (!token) return false;
  const s = await env.DB.prepare("SELECT pw_version, expires_at FROM sessions WHERE token_hash = ? AND case_id = ?").bind(await sha256(token), profile.id).first<any>();
  return !!s && s.pw_version === profile.pw_version && s.expires_at > new Date().toISOString();
}

const b64 = (u: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(u instanceof Uint8Array ? u.buffer : u)));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const aesKey = (env: Env) => crypto.subtle.importKey("raw", unb64(env.PASSWORD_KEY), "AES-GCM", false, ["encrypt", "decrypt"]);
async function seal(env: Env, text: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  return { enc: b64(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(env), new TextEncoder().encode(text))), iv: b64(iv) };
}
async function unseal(env: Env, enc: string, iv: string) {
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, await aesKey(env), unb64(enc)));
}
// Profile passwords are hashed for checking and encrypted separately, so only the admin page can show them.
async function setProfilePassword(env: Env, id: string, password: string, actor: string, ray: string) {
  const salt = randomToken(), sealed = await seal(env, password);
  await env.DB.batch([
    env.DB.prepare("UPDATE profiles SET password_hash = ?, password_salt = ?, password_enc = ?, password_iv = ?, pw_version = pw_version + 1 WHERE id = ?").bind(await sha256(salt + password), salt, sealed.enc, sealed.iv, id),
    env.DB.prepare("DELETE FROM sessions WHERE case_id = ?").bind(id),
    audit(env, null, actor, "password_changed", "profile=" + id, ray),
  ]);
}

// There is deliberately no lockout: visitors are welcome to try passwords while this is a showcase.
async function unlock(request: Request, env: Env, profile: ProfileRow, ray: string) {
  const body = await request.json().catch(() => null) as { password?: unknown } | null;
  if (typeof body?.password !== "string" || body.password.length > 200) return json({ error: "bad_request" }, 400);
  if (!profile.password_hash || !profile.password_salt) return json({ error: "no_password" }, 409);
  if ((await sha256(profile.password_salt + body.password)) !== profile.password_hash) return json({ error: "wrong_password" }, 401);
  const now = new Date();
  const token = randomToken(), expires = new Date(now.getTime() + SESSION_DAYS * 86_400_000).toISOString();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO sessions(token_hash, case_id, pw_version, expires_at) VALUES (?,?,?,?)").bind(await sha256(token), profile.id, profile.pw_version, expires),
    env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now.toISOString()),
    audit(env, null, "editor", "unlock", "profile=" + profile.id, ray),
  ]);
  return json({ ok: true }, 200, { "Set-Cookie": `${cookieName(profile.id)}=${token}; Path=/; Max-Age=${SESSION_DAYS * 86_400}; HttpOnly; Secure; SameSite=Strict` });
}

async function submit(env: Env, row: CaseRow, key: string, ray: string) {
  const seen = await env.DB.prepare("SELECT seq, submitted_at, answered, total, changed_json FROM submissions WHERE case_id = ? AND idem_key = ?").bind(row.id, key).first<any>();
  if (seen) return json({ seq: seen.seq, submittedAt: seen.submitted_at, answered: seen.answered, total: seen.total, changed: parse(seen.changed_json, []), replay: true });

  const current = await currentAnswers(env, row.id);
  const items = flatten(parse<Section[]>(row.questions_json, [])).map((q) => ({ ...q, answer: current[q.id]?.text ?? "", updatedAt: current[q.id]?.updatedAt ?? null }));
  const answered = items.filter((i) => i.answer.trim()).length;
  if (!answered) return json({ error: "no_saved_answers" }, 409);

  const prev = await env.DB.prepare("SELECT seq, payload FROM submissions WHERE case_id = ? ORDER BY seq DESC LIMIT 1").bind(row.id).first<any>();
  const before = new Map(parse<{ id: string; answer: string }[]>(prev?.payload ?? "[]", []).map((i) => [i.id, i.answer]));
  const changed = prev ? items.filter((i) => (before.get(i.id) ?? "") !== i.answer).map((i) => i.id) : [];
  const payload = JSON.stringify(items);
  const hash = await sha256(payload);
  const seq = (prev?.seq ?? 0) + 1;
  const at = new Date().toISOString();
  try {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO submissions(case_id, seq, idem_key, submitted_at, answered, total, changed_json, payload, sha256) VALUES (?,?,?,?,?,?,?,?,?)")
        .bind(row.id, seq, key, at, answered, items.length, JSON.stringify(changed), payload, hash),
      env.DB.prepare("UPDATE cases SET status = CASE WHEN status = 'open' THEN 'submitted' ELSE status END, updated_at = ? WHERE id = ?").bind(at, row.id),
      audit(env, row.id, "editor", "submit", `seq=${seq} answered=${answered}`, ray),
    ]);
  } catch {
    log(env, ray, "warn", "submit_conflict", { case_id: row.id });
    return json({ error: "conflict" }, 503);
  }
  log(env, ray, "info", "submitted", { case_id: row.id, seq, answered });
  return json({ seq, submittedAt: at, answered, total: items.length, changed });
}

async function directory(env: Env) {
  const profiles = await env.DB.prepare("SELECT id, slug, name FROM profiles ORDER BY created_at").all<any>();
  const pages = await env.DB.prepare(`SELECT c.profile_id, c.slug, c.title, c.status,
    (SELECT COALESCE(SUM(e.usd_micro), 0) FROM cost_entries e WHERE e.case_id = c.id) AS micro,
    EXISTS (SELECT 1 FROM reroutes r WHERE r.case_id = c.id AND r.handled_at IS NULL) AS rerouting
    FROM cases c WHERE c.status != 'draft' ORDER BY c.created_at`).all<any>();
  return profiles.results.map((p) => ({
    slug: p.slug, name: p.name,
    pages: pages.results.filter((c) => c.profile_id === p.id).map((c) => ({ slug: c.slug, title: c.title, status: c.status, costUsd: c.micro / 1_000_000, rerouting: !!c.rerouting })),
  })).filter((p) => p.pages.length);
}

async function pageApi(request: Request, env: Env, row: CaseRow, rest: string, ray: string) {
  const profile = await profileOf(env, row.profile_id);
  if (!profile) return notFound();
  const editable = await canEdit(request, env, profile);
  if (rest === "" && request.method === "GET") {
    const last = await env.DB.prepare("SELECT seq, submitted_at, payload FROM submissions WHERE case_id = ? ORDER BY seq DESC LIMIT 1").bind(row.id).first<any>();
    return json({
      title: row.title, name: profile.name, profileSlug: profile.slug, status: row.status,
      intro: parse(row.intro_json, []), plan: parse(row.plan_json, []), costUsd: await costUsd(env, row.id),
      hasPassword: !!profile.password_hash, editable, reroute: await openReroute(env, row.id), seq: last?.seq ?? null, submittedAt: last?.submitted_at ?? null,
      items: last ? parse(last.payload, []) : flatten(parse<Section[]>(row.questions_json, [])).map((q) => ({ ...q, answer: "" })),
      ...(editable ? { sections: parse(row.questions_json, []), answers: await currentAnswers(env, row.id), submissions: await summaries(env, row.id) } : {}),
    });
  }
  if (rest === "unlock" && request.method === "POST") return unlock(request, env, profile, ray);
  if (rest === "lock" && request.method === "POST") {
    const token = readCookie(request, cookieName(profile.id));
    if (token) await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(token)).run();
    return json({ ok: true }, 200, { "Set-Cookie": `${cookieName(profile.id)}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict` });
  }
  if (!(rest === "answers" && request.method === "PUT") && !((rest === "submit" || rest === "reroute") && request.method === "POST")) return notFound();
  if (!editable) return json({ error: "locked" }, 401);
  if (row.status === "closed") return json({ error: "closed" }, 403);

  if (rest === "reroute") {
    // This only records the request. Research restarts when the owner runs it.
    const body = await request.json().catch(() => null) as { message?: unknown } | null;
    const message = typeof body?.message === "string" ? body.message.trim() : "";
    if (!message) return json({ error: "empty" }, 400);
    if (message.length > MAX_REROUTE) return json({ error: "too_long", max: MAX_REROUTE }, 413);
    const at = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare("UPDATE reroutes SET handled_at = ? WHERE case_id = ? AND handled_at IS NULL").bind(at, row.id),
      env.DB.prepare("INSERT INTO reroutes(case_id, message, at) VALUES (?,?,?)").bind(row.id, message, at),
      audit(env, row.id, "editor", "reroute", null, ray),
    ]);
    return json({ message, at });
  }
  if (rest === "submit") {
    const body = await request.json().catch(() => null) as { key?: unknown } | null;
    if (typeof body?.key !== "string" || !/^[\w-]{8,64}$/.test(body.key)) return json({ error: "bad_request" }, 400);
    return submit(env, row, body.key, ray);
  }
  const body = await request.json().catch(() => null) as { answers?: Record<string, unknown>; bases?: Record<string, string | null> } | null;
  if (!body?.answers || typeof body.answers !== "object") return json({ error: "bad_request" }, 400);
  const known = new Set(flatten(parse<Section[]>(row.questions_json, [])).map((q) => q.id));
  const entries = Object.entries(body.answers);
  if (!entries.length) return json({ error: "bad_request" }, 400);
  for (const [id, text] of entries) {
    if (!known.has(id)) return json({ error: "unknown_question", id }, 404);
    if (typeof text !== "string") return json({ error: "bad_request", id }, 400);
    if (text.length > MAX_ANSWER) return json({ error: "too_long", id, max: MAX_ANSWER }, 413);
  }
  // Refuse to overwrite text saved elsewhere after this page loaded it.
  const current = await currentAnswers(env, row.id);
  const conflicts = entries.map(([id]) => id).filter((id) => (current[id]?.updatedAt ?? null) !== (body.bases?.[id] ?? null));
  if (conflicts.length) return json({ error: "conflict", conflicts }, 409);
  const updatedAt = new Date().toISOString();
  await env.DB.batch(entries.map(([id, text]) =>
    env.DB.prepare("INSERT INTO answers(case_id, question_id, text, updated_at) VALUES (?,?,?,?) ON CONFLICT(case_id, question_id) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at")
      .bind(row.id, id, text as string, updatedAt)));
  return json({ saved: entries.length, updatedAt });
}

async function getSettings(env: Env) {
  const r = await env.DB.prepare("SELECT key, value FROM settings").all<{ key: string; value: string }>();
  return Object.fromEntries(r.results.map((x) => [x.key, x.value])) as Record<string, string | undefined>;
}
const setSettings = (env: Env, kv: Record<string, string>) => env.DB.batch(Object.entries(kv).map(([k, v]) =>
  env.DB.prepare("INSERT INTO settings(key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(k, v)));
async function adminLoggedIn(request: Request, env: Env) {
  const token = readCookie(request, "pp_admin");
  if (!token) return false;
  const s = await env.DB.prepare("SELECT expires_at FROM sessions WHERE token_hash = ? AND case_id = ?").bind(await sha256(token), ADMIN_SESSION).first<any>();
  return !!s && s.expires_at > new Date().toISOString();
}

// The site's admin area. It uses the master password, separate from the helper's bearer token.
async function adminSite(request: Request, env: Env, parts: string[], ray: string) {
  const [what, id, sub] = parts;
  const conf = await getSettings(env);
  if (what === "state" && request.method === "GET") return json({ configured: !!conf.master_hash, loggedIn: await adminLoggedIn(request, env) });
  if (what === "setup" && request.method === "POST") {
    const b = await request.json().catch(() => null) as { code?: unknown; password?: unknown } | null;
    const valid = typeof b?.code === "string" && conf.setup_hash === await sha256(b.code) && (conf.setup_expires ?? "") > new Date().toISOString();
    if (!valid) return json({ error: "invalid_code" }, 403);
    if (typeof b?.password !== "string" || b.password.length < 10 || b.password.length > 200) return json({ error: "too_short" }, 400);
    const salt = randomToken();
    await setSettings(env, { master_salt: salt, master_hash: await sha256(salt + b.password), setup_hash: "", setup_expires: "", admin_fails: "0", admin_locked_until: "" });
    await env.DB.batch([env.DB.prepare("DELETE FROM sessions WHERE case_id = ?").bind(ADMIN_SESSION), audit(env, null, "admin", "master_password_set", null, ray)]);
    return json({ ok: true });
  }
  if (what === "login" && request.method === "POST") {
    if (!conf.master_hash || !conf.master_salt) return json({ error: "not_configured" }, 409);
    const b = await request.json().catch(() => null) as { password?: unknown } | null;
    const now = new Date();
    if ((conf.admin_locked_until ?? "") > now.toISOString()) return json({ error: "locked" }, 429);
    if (typeof b?.password !== "string" || (await sha256(conf.master_salt + b.password)) !== conf.master_hash) {
      const fails = Number(conf.admin_fails ?? 0) + 1, locked = fails >= ADMIN_MAX_FAILS;
      await setSettings(env, { admin_fails: locked ? "0" : String(fails), admin_locked_until: locked ? new Date(now.getTime() + ADMIN_LOCK_MINUTES * 60_000).toISOString() : "" });
      log(env, ray, "warn", "admin_login_failed", { fails });
      return json({ error: locked ? "locked" : "wrong_password" }, locked ? 429 : 401);
    }
    const token = randomToken();
    await setSettings(env, { admin_fails: "0", admin_locked_until: "" });
    await env.DB.batch([
      env.DB.prepare("INSERT INTO sessions(token_hash, case_id, pw_version, expires_at) VALUES (?,?,?,?)").bind(await sha256(token), ADMIN_SESSION, 0, new Date(now.getTime() + ADMIN_HOURS * 3_600_000).toISOString()),
      audit(env, null, "admin", "login", null, ray),
    ]);
    return json({ ok: true }, 200, { "Set-Cookie": `pp_admin=${token}; Path=/; Max-Age=${ADMIN_HOURS * 3600}; HttpOnly; Secure; SameSite=Strict` });
  }
  if (!(await adminLoggedIn(request, env))) return json({ error: "login_required" }, 401);
  if (what === "logout" && request.method === "POST") {
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(readCookie(request, "pp_admin")!)).run();
    return json({ ok: true }, 200, { "Set-Cookie": "pp_admin=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict" });
  }
  if (what === "overview" && request.method === "GET") {
    const profiles = await env.DB.prepare(`SELECT p.id, p.name, p.slug, p.password_hash IS NOT NULL AS has_password, (SELECT COUNT(*) FROM cases c WHERE c.profile_id = p.id) AS pages FROM profiles p ORDER BY p.created_at`).all();
    const r = await env.DB.prepare(`SELECT c.id, c.title, c.status, c.updated_at, c.questions_json, p.name AS profile, p.slug AS profile_slug, c.slug,
      (SELECT COUNT(*) FROM submissions s WHERE s.case_id = c.id) AS submissions,
      (SELECT COUNT(*) FROM answers a WHERE a.case_id = c.id AND trim(a.text) != '') AS saved,
      EXISTS (SELECT 1 FROM reroutes r WHERE r.case_id = c.id AND r.handled_at IS NULL) AS rerouting,
      (SELECT COALESCE(SUM(e.usd_micro), 0) / 1000000.0 FROM cost_entries e WHERE e.case_id = c.id) AS cost_usd
      FROM cases c JOIN profiles p ON p.id = c.profile_id ORDER BY c.created_at`).all<any>();
    return json({ profiles: profiles.results, pages: r.results.map(({ questions_json, ...x }) => ({ ...x, total: flatten(parse<Section[]>(questions_json, [])).length })) });
  }
  if (what === "profiles" && !id && request.method === "POST") {
    const b = await request.json().catch(() => null) as { name?: unknown } | null;
    const name = typeof b?.name === "string" ? b.name.trim() : "";
    if (!name || name.length > 80) return json({ error: "bad_name" }, 400);
    return json(await profileFor(env, name, new Date().toISOString()), 201);
  }
  if (what === "profiles" && id) {
    const profile = await profileOf(env, id);
    if (!profile) return json({ error: "not_found" }, 404);
    if (sub === "password" && request.method === "GET") {
      await audit(env, null, "admin", "password_viewed", "profile=" + id, ray).run();
      return json({ password: profile.password_enc && profile.password_iv ? await unseal(env, profile.password_enc, profile.password_iv) : null });
    }
    if (sub === "password" && request.method === "POST") {
      const b = await request.json().catch(() => null) as { password?: unknown } | null;
      if (typeof b?.password !== "string" || b.password.length < 4 || b.password.length > 200) return json({ error: "bad_password" }, 400);
      await setProfilePassword(env, id, b.password, "admin", ray);
      return json({ ok: true });
    }
    return notFound();
  }
  if (what !== "pages" || !id) return notFound();
  const row = await env.DB.prepare("SELECT * FROM cases WHERE id = ?").bind(id).first<CaseRow>();
  if (!row) return json({ error: "not_found" }, 404);

  if (sub === "answers" && request.method === "PUT") {
    const b = await request.json().catch(() => null) as { answers?: Record<string, unknown> } | null;
    const known = new Set(flatten(parse<Section[]>(row.questions_json, [])).map((q) => q.id));
    const entries = Object.entries(b?.answers ?? {});
    if (!entries.length || entries.some(([k, v]) => !known.has(k) || typeof v !== "string" || (v as string).length > MAX_ANSWER)) return json({ error: "bad_request" }, 400);
    const at = new Date().toISOString();
    await env.DB.batch([
      ...entries.map(([k, v]) => env.DB.prepare("INSERT INTO answers(case_id, question_id, text, updated_at) VALUES (?,?,?,?) ON CONFLICT(case_id, question_id) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at").bind(id, k, v as string, at)),
      audit(env, id, "admin", "answers_edited", entries.map(([k]) => k).join(","), ray),
    ]);
    return json({ ok: true });
  }
  if (!sub && request.method === "GET") {
    const p = await env.DB.prepare("SELECT name FROM profiles WHERE id = ?").bind(row.profile_id).first<any>();
    const subs = await env.DB.prepare("SELECT * FROM submissions WHERE case_id = ? ORDER BY seq").bind(id).all<any>();
    const auditRows = await env.DB.prepare("SELECT actor, action, detail, at FROM audit_log WHERE case_id = ? OR detail = ? ORDER BY id DESC LIMIT 50").bind(id, "profile=" + row.profile_id).all();
    const costs = await env.DB.prepare("SELECT usd_micro, label, at FROM cost_entries WHERE case_id = ? ORDER BY id").bind(id).all<any>();
    return json({
      title: row.title, profile: p?.name, status: row.status, sections: parse(row.questions_json, []), answers: await currentAnswers(env, id),
      reroute: await openReroute(env, id), costUsd: await costUsd(env, id), audit: auditRows.results,
      costs: costs.results.map((c) => ({ usd: c.usd_micro / 1_000_000, label: c.label, at: c.at })),
      submissions: await Promise.all(subs.results.map(async (s) => ({ seq: s.seq, submittedAt: s.submitted_at, answered: s.answered, total: s.total, intact: (await sha256(s.payload)) === s.sha256, items: parse(s.payload, null) }))),
    });
  }
  return notFound();
}

async function admin(request: Request, env: Env, parts: string[], ray: string) {
  const auth = request.headers.get("Authorization") ?? "";
  if (!env.ADMIN_TOKEN_SHA256 || !auth.startsWith("Bearer ") || (await sha256(auth.slice(7))) !== env.ADMIN_TOKEN_SHA256) return notFound();
  const [root, id, sub, which] = parts;
  if (root === "setup-code" && request.method === "POST") {
    const code = randomToken();
    await setSettings(env, { setup_hash: await sha256(code), setup_expires: new Date(Date.now() + 30 * 60_000).toISOString() });
    return json({ code });
  }
  if (root !== "cases") return notFound();
  const now = new Date().toISOString();

  if (!id && request.method === "GET") {
    const r = await env.DB.prepare(`SELECT c.id, c.title, c.status, c.updated_at, p.name AS profile, p.slug AS profile_slug, c.slug,
      p.password_hash IS NOT NULL AS has_password,
      (SELECT COUNT(*) FROM submissions s WHERE s.case_id = c.id) AS submissions,
      EXISTS (SELECT 1 FROM reroutes r WHERE r.case_id = c.id AND r.handled_at IS NULL) AS rerouting,
      (SELECT COALESCE(SUM(e.usd_micro), 0) / 1000000.0 FROM cost_entries e WHERE e.case_id = c.id) AS cost_usd
      FROM cases c LEFT JOIN profiles p ON p.id = c.profile_id ORDER BY c.created_at`).all();
    return json({ cases: r.results });
  }
  if (!id && request.method === "POST") {
    const b = await request.json().catch(() => null) as { title?: string; profile?: string } | null;
    if (!b?.title || !b.profile) return json({ error: "title and profile required" }, 400);
    const caseId = crypto.randomUUID().slice(0, 8);
    const p = await profileFor(env, b.profile, now);
    const slug = await freeSlug(env, "cases", slugify(b.title), p.id);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO cases(id, token_hash, title, first_name, profile_id, slug, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)").bind(caseId, await sha256(randomToken()), b.title, b.profile, p.id, slug, now, now),
      audit(env, caseId, "admin", "create", null, ray),
    ]);
    return json({ id: caseId, path: `/probes/${p.slug}/${slug}` }, 201);
  }
  if (!id) return notFound();
  const row = await env.DB.prepare("SELECT * FROM cases WHERE id = ?").bind(id).first<CaseRow>();
  if (!row) return json({ error: "not_found" }, 404);

  if (!sub && request.method === "GET") {
    const p = await env.DB.prepare("SELECT slug, name FROM profiles WHERE id = ?").bind(row.profile_id).first<any>();
    return json({ id: row.id, title: row.title, profile: p?.name, path: `/probes/${p?.slug}/${row.slug}`, status: row.status, hasPassword: !!(await profileOf(env, row.profile_id))?.password_hash, costUsd: await costUsd(env, id), reroute: await openReroute(env, id), sections: parse(row.questions_json, []), answers: await currentAnswers(env, id), submissions: await summaries(env, id) });
  }
  if (!sub && request.method === "PATCH") {
    const b = await request.json().catch(() => null) as { intro?: unknown; questions?: unknown; plan?: unknown; status?: string } | null;
    if (!b) return json({ error: "bad_request" }, 400);
    if (b.questions !== undefined && !validSections(b.questions)) return json({ error: "invalid_questions" }, 400);
    if (b.intro !== undefined && !validBlocks(b.intro)) return json({ error: "invalid_intro" }, 400);
    if (b.plan !== undefined && !validBlocks(b.plan)) return json({ error: "invalid_plan" }, 400);
    if (b.status !== undefined && !STATUSES.includes(b.status)) return json({ error: "invalid_status" }, 400);
    const intro = b.intro !== undefined ? JSON.stringify(b.intro) : row.intro_json;
    const questions = b.questions !== undefined ? JSON.stringify(b.questions) : row.questions_json;
    const plan = b.plan !== undefined ? JSON.stringify(b.plan) : row.plan_json;
    if (intro.length + questions.length + plan.length > MAX_DOC) return json({ error: "too_large" }, 413);
    await env.DB.batch([
      env.DB.prepare("UPDATE cases SET intro_json = ?, questions_json = ?, plan_json = ?, status = ?, updated_at = ? WHERE id = ?").bind(intro, questions, plan, b.status ?? row.status, now, id),
      // New questions answer an open change of direction.
      ...(b.questions !== undefined ? [env.DB.prepare("UPDATE reroutes SET handled_at = ? WHERE case_id = ? AND handled_at IS NULL").bind(now, id)] : []),
      audit(env, id, "admin", "update", Object.keys(b).join(","), ray),
    ]);
    return json({ ok: true });
  }
  if (sub === "costs" && request.method === "POST") {
    const b = await request.json().catch(() => null) as { usd?: unknown; label?: unknown } | null;
    if (typeof b?.usd !== "number" || !Number.isFinite(b.usd) || typeof b.label !== "string" || !b.label) return json({ error: "bad_request" }, 400);
    await env.DB.prepare("INSERT INTO cost_entries(case_id, usd_micro, label, at) VALUES (?,?,?,?)").bind(id, Math.round(b.usd * 1_000_000), b.label, now).run();
    return json({ costUsd: await costUsd(env, id) });
  }
  if (sub === "password" && request.method === "POST") {
    const b = await request.json().catch(() => null) as { password?: unknown } | null;
    if (typeof b?.password !== "string" || b.password.length < 4 || b.password.length > 200) return json({ error: "password must be 4 to 200 characters" }, 400);
    await setProfilePassword(env, row.profile_id!, b.password, "cli", ray);
    return json({ ok: true });
  }
  if (!sub && request.method === "DELETE") {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM answers WHERE case_id = ?").bind(id),
      env.DB.prepare("DELETE FROM cost_entries WHERE case_id = ?").bind(id),
      env.DB.prepare("DELETE FROM submissions WHERE case_id = ?").bind(id),
      env.DB.prepare("DELETE FROM reroutes WHERE case_id = ?").bind(id),
      env.DB.prepare("DELETE FROM cases WHERE id = ?").bind(id),
      env.DB.prepare("DELETE FROM sessions WHERE case_id = ? AND NOT EXISTS (SELECT 1 FROM cases WHERE profile_id = ?)").bind(row.profile_id, row.profile_id),
      env.DB.prepare("DELETE FROM profiles WHERE id = ? AND NOT EXISTS (SELECT 1 FROM cases WHERE profile_id = ?)").bind(row.profile_id, row.profile_id),
      audit(env, id, "admin", "purge", null, ray),
    ]);
    return json({ ok: true });
  }
  if (sub === "submissions" && request.method === "GET") {
    if (!which) return json({ submissions: await summaries(env, id) });
    const r = which === "latest"
      ? await env.DB.prepare("SELECT * FROM submissions WHERE case_id = ? ORDER BY seq DESC LIMIT 1").bind(id).first<any>()
      : await env.DB.prepare("SELECT * FROM submissions WHERE case_id = ? AND seq = ?").bind(id, Number(which)).first<any>();
    if (!r) return json({ error: "not_found" }, 404);
    return json({ seq: r.seq, submittedAt: r.submitted_at, answered: r.answered, total: r.total, changed: parse(r.changed_json, []), intact: (await sha256(r.payload)) === r.sha256, items: parse(r.payload, null) });
  }
  return notFound();
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const ray = request.headers.get("cf-ray") ?? crypto.randomUUID();
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    const page = request.method === "GET" || request.method === "HEAD";
    try {
      if (!parts.length && page) return html(LANDING, request);
      if (parts[0] === "probes" && (parts.length === 1 || parts.length === 3) && page) return html(APP, request);
      if (parts[0] === "admin" && parts.length === 1 && page) return html(ADMIN, request);
      if (!schemaReady) { await migrate(env); schemaReady = true; }
      if (parts[0] === "api" && parts[1] === "admin") return await adminSite(request, env, parts.slice(2), ray);
      if (parts[0] === "admin") return await admin(request, env, parts.slice(1), ray);
      if (parts[0] !== "api") return notFound();
      if (parts[1] === "probes" && parts.length === 2 && page) return json({ profiles: await directory(env) });
      if (parts[1] === "pages" && parts[2] && parts[3]) {
        const row = await env.DB.prepare("SELECT c.* FROM cases c JOIN profiles p ON p.id = c.profile_id WHERE p.slug = ? AND c.slug = ? AND c.status != 'draft'").bind(parts[2], parts[3]).first<CaseRow>();
        if (!row) return json({ error: "not_found" }, 404);
        return await pageApi(request, env, row, parts.slice(4).join("/"), ray);
      }
      return notFound();
    } catch (e) {
      log(env, ray, "error", "unhandled", { error: String(e) });
      return json({ error: "server_error", ray_id: ray }, 500);
    }
  },
};
