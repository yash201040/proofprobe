import APP from "./page.html";
import LANDING from "./landing.html";
import ADMIN from "./admin.html";
import REQUEST from "./request.html";
import ACCOUNT from "./account.txt";
import { SCHEMA } from "./schema";

export interface Env { DB: D1Database; APP_VERSION: string; ADMIN_TOKEN_SHA256: string; PASSWORD_KEY: string }

const MAX_ANSWER = 30_000;
const MAX_DOC = 300_000;
const MAX_REROUTE = 5_000;
const SESSION_DAYS = 30;
const ADMIN_DAYS = 90;
const ADMIN_MAX_FAILS = 6;
const ADMIN_LOCK_MINUTES = 15;
const ADMIN_SESSION = "__admin";
const SCHEMA_VERSION = "6";
const MAX_PENDING_PROFILES = 100;
const SIGNIN_MAX_MISSES = 20, SIGNIN_WINDOW_MS = 15 * 60_000;
const APPLICATIONS_PER_HOUR = 5;
const MAX_FILES = 5;
const MAX_UPLOAD = 10 * 1024 * 1024;
const CHUNK = 1024 * 1024;
const MAX_REQUEST_BODY = 20_000;
const REQUESTS_PER_HOUR = 5;
const MAX_OPEN_REQUESTS = 100;
const FIRST_STEP = "Research and questions";
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
const CSP = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'";

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

interface Question { id: string; text: string; why?: string; kind?: "decision"; lean?: string }
interface Section { title: string; note?: string; first?: boolean; questions: Question[] }
interface CaseRow {
  id: string; title: string; first_name: string; status: string;
  created_at: string; updated_at: string; profile_id: string | null; slug: string | null;
  p_name: string; p_slug: string;
}
interface Step { n: number; title: string; intro: unknown[]; sections: Section[]; plan: unknown[]; createdAt: string }
interface ProfileRow { id: string; slug: string; name: string; status: string; reason: string | null; password_hash: string | null; password_salt: string | null; password_enc: string | null; password_iv: string | null; pw_version: number }

async function freeSlug(env: Env, table: "profiles" | "cases", base: string, scope?: string) {
  for (let i = 1; ; i++) {
    const slug = i === 1 ? base : `${base}-${i}`;
    const hit = table === "profiles"
      ? await env.DB.prepare("SELECT 1 FROM profiles WHERE slug = ?").bind(slug).first()
      : await env.DB.prepare("SELECT 1 FROM cases WHERE profile_id = ? AND slug = ?").bind(scope!, slug).first();
    if (!hit) return slug;
  }
}
const tidyName = (s: string) => s.normalize("NFKC").trim().replace(/\s+/g, " ");
const sameName = (a: string, b: string) => tidyName(a).toLowerCase() === tidyName(b).toLowerCase();
async function findProfile(env: Env, name: string) {
  const all = await env.DB.prepare("SELECT id, slug, name FROM profiles ORDER BY created_at").all<{ id: string; slug: string; name: string }>();
  return { match: all.results.find((p) => sameName(p.name, name)), names: all.results.map((p) => p.name) };
}
async function createProfile(env: Env, name: string, now: string) {
  const id = crypto.randomUUID().slice(0, 8), clean = tidyName(name), slug = await freeSlug(env, "profiles", slugify(clean));
  await env.DB.prepare("INSERT INTO profiles(id, slug, name, created_at) VALUES (?,?,?,?)").bind(id, slug, clean, now).run();
  return { id, slug, name: clean };
}

// One indexed read on a new isolate decides whether anything below needs to run.
async function schemaCurrent(env: Env) {
  try {
    const r = await env.DB.prepare("SELECT value FROM settings WHERE key = 'schema_version'").first<{ value: string }>();
    return r?.value === SCHEMA_VERSION;
  } catch { return false; }
}
async function migrate(env: Env) {
  await env.DB.batch(SCHEMA.map((q) => env.DB.prepare(q)));
  const pcols = new Set((await env.DB.prepare("SELECT name FROM pragma_table_info('profiles')").all()).results.map((r: any) => r.name as string));
  if (!pcols.has("status")) await env.DB.prepare("ALTER TABLE profiles ADD COLUMN status TEXT NOT NULL DEFAULT 'active'").run();
  if (!pcols.has("reason")) await env.DB.prepare("ALTER TABLE profiles ADD COLUMN reason TEXT").run();
  const rcols = new Set((await env.DB.prepare("SELECT name FROM pragma_table_info('requests')").all()).results.map((r: any) => r.name as string));
  if (!rcols.has("profile_id")) await env.DB.prepare("ALTER TABLE requests ADD COLUMN profile_id TEXT").run();
  const subs = new Set((await env.DB.prepare("SELECT name FROM pragma_table_info('submissions')").all()).results.map((r: any) => r.name as string));
  if (!subs.has("step_n")) await env.DB.prepare("ALTER TABLE submissions ADD COLUMN step_n INTEGER NOT NULL DEFAULT 1").run();
  const cols = new Set((await env.DB.prepare("SELECT name FROM pragma_table_info('cases')").all()).results.map((r: any) => r.name as string));
  if (cols.has("intro_json")) {
    // Pages used to hold one set of content. It becomes their first step.
    await env.DB.prepare(`INSERT OR IGNORE INTO steps(case_id, n, title, intro_json, questions_json, plan_json, created_at)
      SELECT id, 1, ?, intro_json, questions_json, plan_json, created_at FROM cases`).bind(FIRST_STEP).run();
  }
  for (const old of ["intro_json", "questions_json", "plan_json", "questions_at", "plan_at", "password_hash", "password_salt", "password_enc", "password_iv", "pw_version"])
    if (cols.has(old)) await env.DB.prepare(`ALTER TABLE cases DROP COLUMN ${old}`).run();
  await setSettings(env, { schema_version: SCHEMA_VERSION });
}

async function loadSteps(env: Env, id: string): Promise<Step[]> {
  const r = await env.DB.prepare("SELECT * FROM steps WHERE case_id = ? ORDER BY n").bind(id).all<any>();
  return r.results.map((x) => ({ n: x.n, title: x.title, intro: parse(x.intro_json, []), sections: parse<Section[]>(x.questions_json, []), plan: parse(x.plan_json, []), createdAt: x.created_at }));
}
// People answer the newest step that has questions. Earlier steps stay as they were.
const answerStep = (steps: Step[]) => [...steps].reverse().find((x) => flatten(x.sections).length) ?? null;

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
      // A proposal is answered Accept, Reject or Auto, and Auto leaves the choice to the final research.
      if (q.kind !== undefined && q.kind !== "decision") return false;
      if (q.lean !== undefined && (typeof q.lean !== "string" || q.lean.length > 400)) return false;
      ids.add(q.id);
    }
  }
  return true;
}
const isStrings = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string");
const isScore = (n: unknown) => n === undefined || (typeof n === "number" && Number.isFinite(n) && n >= 0);
const isInfo = (s: unknown) => s === undefined || (typeof s === "string" && s.length <= 500);
const isCell = (c: any) => typeof c === "string" || (typeof c?.text === "string" && (c.tone === undefined || TONES.includes(c.tone)) && isScore(c.score) && isScore(c.max) && isInfo(c.info));
function validBlock(b: any): boolean {
  if (b?.t === "section") return typeof b.title === "string" && Array.isArray(b.blocks) && b.blocks.every(validBlock);
  if (["h2", "h3", "p", "callout"].includes(b?.t)) return typeof b.text === "string";
  if (b?.t === "ul" || b?.t === "ol") return isStrings(b.items);
  if (b?.t === "bars") return typeof b.title === "string" && isScore(b.max) && Array.isArray(b.items) && b.items.every((i: any) => typeof i?.label === "string" && typeof i.value === "number" && isScore(i.value) && isInfo(i.info));
  if (b?.t === "table") return isStrings(b.head) && Array.isArray(b.rows) && b.rows.every((r: unknown) => Array.isArray(r) && r.every(isCell));
  if (b?.t === "because") return typeof b.decision === "string" && (b.evidence === undefined || (Array.isArray(b.evidence) && b.evidence.every((e: any) => typeof e === "string" || (typeof e?.text === "string" && isInfo(e.info))))) && (b.shapedBy === undefined || typeof b.shapedBy === "string");
  if (b?.t === "links") return Array.isArray(b.links) && b.links.every((k: any) => typeof k?.url === "string");
  return false;
}
const validBlocks = (v: unknown) => Array.isArray(v) && v.every(validBlock);

// What's waiting for the owner. This is only a list: nothing here can start research.
async function pendingWork(env: Env) {
  const r = await env.DB.prepare(`SELECT c.id, c.title, p.name AS profile, p.slug AS profile_slug, c.slug,
    (SELECT message FROM reroutes x WHERE x.case_id = c.id AND x.handled_at IS NULL ORDER BY x.id DESC LIMIT 1) AS reroute,
    (SELECT at FROM reroutes x WHERE x.case_id = c.id AND x.handled_at IS NULL ORDER BY x.id DESC LIMIT 1) AS reroute_at,
    (SELECT MAX(submitted_at) FROM submissions s WHERE s.case_id = c.id) AS last_submitted,
    (SELECT MAX(created_at) FROM steps t WHERE t.case_id = c.id) AS latest_step,
    (SELECT questions_json FROM steps t WHERE t.case_id = c.id AND questions_json != '[]' ORDER BY n DESC LIMIT 1) AS open_questions
    FROM cases c JOIN profiles p ON p.id = c.profile_id WHERE c.status NOT IN ('draft', 'closed') ORDER BY c.created_at`).all<any>();
  const approved = await env.DB.prepare("SELECT id, name, title, decided_at FROM requests WHERE status = 'approved' ORDER BY decided_at").all<any>();
  const queued = approved.results.map((q) => ({ id: q.id, profile: q.name, title: q.title, path: null, prompt: `/proofprobe start request ${q.id}`, kind: "request", since: q.decided_at, detail: null }));
  return [...queued, ...r.results.flatMap((c) => {
    const base = { id: c.id, profile: c.profile, title: c.title, path: `/probes/${c.profile_slug}/${c.slug}`, prompt: `/proofprobe continue ${c.profile}: ${c.title}` };
    if (c.reroute) return [{ ...base, kind: "reroute", since: c.reroute_at, detail: c.reroute }];
    // Decisions on proposals lead to the final version, while plain answers lead to in-depth research.
    const decided = parse<Section[]>(c.open_questions, []).some((x) => x.questions.some((q) => q.kind === "decision"));
    return c.last_submitted && c.last_submitted > c.latest_step ? [{ ...base, kind: decided ? "decisions" : "answers", since: c.last_submitted, detail: null }] : [];
  })];
}
async function setProfileStatus(env: Env, id: string, status: string, ray: string) {
  await env.DB.batch([
    env.DB.prepare("UPDATE profiles SET status = ? WHERE id = ?").bind(status, id),
    ...(status === "active" ? [] : [env.DB.prepare("DELETE FROM sessions WHERE case_id = ?").bind(id)]),
    audit(env, null, "admin", "profile_" + status, "profile=" + id, ray),
  ]);
}
async function createRequest(request: Request, env: Env, ray: string) {
  const me = await signedIn(request, env);
  if (!me) return json({ error: "sign_in_required" }, 401);
  const form = await request.formData().catch(() => null);
  if (!form) return json({ error: "bad_request" }, 400);
  const text = (k: string) => { const v = form.get(k); return typeof v === "string" ? v.trim() : ""; };
  const name = me.name, contact = text("contact"), title = text("title"), body = text("body");
  if (!contact || !title || body.length < 40 || contact.length > 160 || title.length > 140 || body.length > MAX_REQUEST_BODY) return json({ error: "bad_request" }, 400);
  const files = form.getAll("files").filter((f): f is File => typeof f !== "string" && f.size > 0);
  if (files.length > MAX_FILES || files.reduce((a, f) => a + f.size, 0) > MAX_UPLOAD) return json({ error: "too_large" }, 413);
  const ip = await sha256("profile:" + me.id), hourAgo = new Date(Date.now() - 3_600_000).toISOString();
  const [recent, open] = await env.DB.batch([
    env.DB.prepare("SELECT COUNT(*) AS n FROM requests WHERE ip_hash = ? AND created_at > ?").bind(ip, hourAgo),
    env.DB.prepare("SELECT COUNT(*) AS n FROM requests WHERE status = 'new'"),
  ]);
  if ((recent.results[0] as any).n >= REQUESTS_PER_HOUR || (open.results[0] as any).n >= MAX_OPEN_REQUESTS) return json({ error: "rate_limited" }, 429);
  const id = crypto.randomUUID().slice(0, 8), now = new Date().toISOString();
  const writes = [env.DB.prepare("INSERT INTO requests(id, profile_id, name, contact, title, body, ip_hash, created_at) VALUES (?,?,?,?,?,?,?,?)").bind(id, me.id, name, contact, title, body, ip, now)];
  for (const f of files) {
    const fid = crypto.randomUUID().slice(0, 12), bytes = new Uint8Array(await f.arrayBuffer());
    writes.push(env.DB.prepare("INSERT INTO request_files(id, request_id, name, size, created_at) VALUES (?,?,?,?,?)").bind(fid, id, f.name.slice(0, 180) || "file", f.size, now));
    for (let i = 0, n = 0; i < bytes.length; i += CHUNK, n++) writes.push(env.DB.prepare("INSERT INTO file_chunks(file_id, i, data) VALUES (?,?,?)").bind(fid, n, bytes.slice(i, i + CHUNK).buffer));
  }
  writes.push(audit(env, null, "visitor", "request_created", "request=" + id, ray));
  await env.DB.batch(writes);
  return json({ ref: "PP-" + id.toUpperCase() }, 201);
}
async function requestDetail(env: Env, id: string) {
  const q = await env.DB.prepare("SELECT id, name AS profile, contact, title, body, status, case_id, created_at, decided_at FROM requests WHERE id = ?").bind(id).first<any>();
  if (!q) return null;
  const f = await env.DB.prepare("SELECT id, name, size FROM request_files WHERE request_id = ? ORDER BY created_at, name").bind(id).all();
  return { ...q, files: f.results };
}
async function setRequestStatus(env: Env, id: string, status: string, caseId: string | null, ray: string) {
  await env.DB.batch([
    env.DB.prepare("UPDATE requests SET status = ?, case_id = COALESCE(?, case_id), decided_at = ? WHERE id = ?").bind(status, caseId, new Date().toISOString(), id),
    audit(env, null, "admin", "request_" + status, "request=" + id, ray),
  ]);
}
async function downloadFile(env: Env, requestId: string, fileId: string) {
  const f = await env.DB.prepare("SELECT name FROM request_files WHERE id = ? AND request_id = ?").bind(fileId, requestId).first<{ name: string }>();
  if (!f) return notFound();
  const rows = await env.DB.prepare("SELECT data FROM file_chunks WHERE file_id = ? ORDER BY i").bind(fileId).all<{ data: number[] }>();
  const parts = rows.results.map((r) => new Uint8Array(r.data));
  // Always a download, never rendered here, because the bytes came from the public form.
  return new Response(new Blob(parts), { headers: { ...SEC, "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}` } });
}
async function deleteRequest(env: Env, id: string, ray: string) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM file_chunks WHERE file_id IN (SELECT id FROM request_files WHERE request_id = ?)").bind(id),
    env.DB.prepare("DELETE FROM request_files WHERE request_id = ?").bind(id),
    env.DB.prepare("DELETE FROM requests WHERE id = ?").bind(id),
    audit(env, null, "admin", "request_deleted", "request=" + id, ray),
  ]);
}
async function deleteCase(env: Env, id: string, ray: string) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM answers WHERE case_id = ?").bind(id),
    env.DB.prepare("DELETE FROM cost_entries WHERE case_id = ?").bind(id),
    env.DB.prepare("DELETE FROM submissions WHERE case_id = ?").bind(id),
    env.DB.prepare("DELETE FROM reroutes WHERE case_id = ?").bind(id),
    env.DB.prepare("DELETE FROM steps WHERE case_id = ?").bind(id),
    env.DB.prepare("DELETE FROM cases WHERE id = ?").bind(id),
    audit(env, null, "admin", "page_deleted", id, ray),
  ]);
}
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
async function summariesWithStep(env: Env, caseId: string) {
  const r = await env.DB.prepare("SELECT seq, step_n, submitted_at, answered, total, changed_json FROM submissions WHERE case_id = ? ORDER BY seq").bind(caseId).all<any>();
  return r.results.map((x) => ({ seq: x.seq, stepN: x.step_n, submittedAt: x.submitted_at, answered: x.answered, total: x.total, changed: parse(x.changed_json, []) }));
}
async function currentAnswers(env: Env, caseId: string) {
  const r = await env.DB.prepare("SELECT question_id, text, updated_at FROM answers WHERE case_id = ?").bind(caseId).all();
  const out: Record<string, { text: string; updatedAt: string }> = {};
  for (const x of r.results as any[]) out[x.question_id] = { text: x.text, updatedAt: x.updated_at };
  return out;
}
const audit = (env: Env, caseId: string | null, actor: string, action: string, detail: string | null, ray: string) =>
  env.DB.prepare("INSERT INTO audit_log(case_id, actor, action, detail, ray_id, at) VALUES (?,?,?,?,?,?)").bind(caseId, actor, action, detail, ray, new Date().toISOString());

function readCookie(request: Request, name: string) {
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}
const profileOf = (env: Env, id: string | null) => env.DB.prepare("SELECT * FROM profiles WHERE id = ?").bind(id).first<ProfileRow>();
// One sign-in covers every page in that person's profile, and nobody else's.
async function signedIn(request: Request, env: Env) {
  const token = readCookie(request, "pp_session");
  if (!token) return null;
  return env.DB.prepare(`SELECT p.id, p.slug, p.name FROM sessions s JOIN profiles p ON p.id = s.case_id
    WHERE s.token_hash = ? AND s.pw_version = p.pw_version AND s.expires_at > ? AND p.status = 'active'`).bind(await sha256(token), new Date().toISOString()).first<{ id: string; slug: string; name: string }>();
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

// There is deliberately no lockout on profile passwords.
async function signIn(request: Request, env: Env, ray: string) {
  // Wrong guesses never lock a profile. One device gets a short pause after many misses, so guessing can't run unchecked.
  const ipKey = await sha256("signin:" + (request.headers.get("cf-connecting-ip") ?? "local"));
  const misses = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'sign_in_failed' AND detail = ? AND at > ?").bind(ipKey, new Date(Date.now() - SIGNIN_WINDOW_MS).toISOString()).first<{ n: number }>();
  if ((misses?.n ?? 0) >= SIGNIN_MAX_MISSES) return json({ error: "slow_down" }, 429);
  const body = await request.json().catch(() => null) as { name?: unknown; password?: unknown } | null;
  if (typeof body?.name !== "string" || typeof body.password !== "string" || body.password.length > 200) return json({ error: "bad_request" }, 400);
  const { match } = await findProfile(env, body.name);
  const profile = match ? await profileOf(env, match.id) : null;
  const right = !!profile?.password_hash && !!profile.password_salt && (await sha256(profile.password_salt + body.password)) === profile.password_hash;
  if (!profile || !right) {
    await audit(env, null, "visitor", "sign_in_failed", ipKey, ray).run();
    return json({ error: "wrong_details" }, 401);
  }
  if (profile.status !== "active") return json({ error: "not_approved", status: profile.status }, 403);
  const cookie = await newSession(env, profile.id);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(new Date().toISOString()),
    audit(env, null, "editor", "sign_in", "profile=" + profile.id, ray),
  ]);
  return json({ name: profile.name, slug: profile.slug }, 200, { "Set-Cookie": cookie });
}
async function newSession(env: Env, id: string) {
  const token = randomToken(), expires = new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString();
  await env.DB.prepare("INSERT INTO sessions(token_hash, case_id, pw_version, expires_at) SELECT ?, id, pw_version, ? FROM profiles WHERE id = ?").bind(await sha256(token), expires, id).run();
  return `pp_session=${token}; Path=/; Max-Age=${SESSION_DAYS * 86_400}; HttpOnly; Secure; SameSite=Lax`;
}
// Changing a password signs out every other device, and this one stays signed in.
async function changePassword(request: Request, env: Env, ray: string) {
  const me = await signedIn(request, env);
  if (!me) return json({ error: "sign_in_required" }, 401);
  const b = await request.json().catch(() => null) as { current?: unknown; next?: unknown } | null;
  if (typeof b?.current !== "string" || typeof b.next !== "string" || b.current.length > 200 || b.next.length < 8 || b.next.length > 200) return json({ error: "bad_request" }, 400);
  const profile = await profileOf(env, me.id);
  if (!profile?.password_salt || (await sha256(profile.password_salt + b.current)) !== profile.password_hash) return json({ error: "wrong_password" }, 403);
  if (b.next === b.current) return json({ error: "same_password" }, 400);
  await setProfilePassword(env, me.id, b.next, "editor", ray);
  return json({ ok: true }, 200, { "Set-Cookie": await newSession(env, me.id) });
}
async function signOut(request: Request, env: Env) {
  const token = readCookie(request, "pp_session");
  if (token) await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(token)).run();
  return json({ ok: true }, 200, { "Set-Cookie": "pp_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax" });
}
async function applyForProfile(request: Request, env: Env, ray: string) {
  const b = await request.json().catch(() => null) as { name?: unknown; password?: unknown; reason?: unknown } | null;
  const name = typeof b?.name === "string" ? tidyName(b.name) : "", reason = typeof b?.reason === "string" ? b.reason.trim() : "";
  if (name.length < 2 || name.length > 60 || typeof b?.password !== "string" || b.password.length < 8 || b.password.length > 200 || reason.length < 10 || reason.length > 500) return json({ error: "bad_request" }, 400);
  const ip = await sha256("apply:" + (request.headers.get("cf-connecting-ip") ?? "local")), hourAgo = new Date(Date.now() - 3_600_000).toISOString();
  const [recent, pending] = await env.DB.batch([
    env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'profile_applied' AND detail = ? AND at > ?").bind(ip, hourAgo),
    env.DB.prepare("SELECT COUNT(*) AS n FROM profiles WHERE status = 'pending'"),
  ]);
  if ((recent.results[0] as any).n >= APPLICATIONS_PER_HOUR || (pending.results[0] as any).n >= MAX_PENDING_PROFILES) return json({ error: "rate_limited" }, 429);
  if ((await findProfile(env, name)).match) return json({ error: "name_taken" }, 409);
  const id = crypto.randomUUID().slice(0, 8), now = new Date().toISOString(), slug = await freeSlug(env, "profiles", slugify(name)), salt = randomToken(), sealed = await seal(env, b.password);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO profiles(id, slug, name, status, reason, password_hash, password_salt, password_enc, password_iv, created_at) VALUES (?,?,?,'pending',?,?,?,?,?,?)").bind(id, slug, name, reason, await sha256(salt + b.password), salt, sealed.enc, sealed.iv, now),
    audit(env, null, "visitor", "profile_applied", ip, ray),
  ]);
  return json({ ok: true }, 201);
}

async function submit(env: Env, row: CaseRow, key: string, ray: string) {
  const seen = await env.DB.prepare("SELECT seq, submitted_at, answered, total, changed_json FROM submissions WHERE case_id = ? AND idem_key = ?").bind(row.id, key).first<any>();
  if (seen) return json({ seq: seen.seq, submittedAt: seen.submitted_at, answered: seen.answered, total: seen.total, changed: parse(seen.changed_json, []), replay: true });

  const step = answerStep(await loadSteps(env, row.id));
  if (!step) return json({ error: "no_questions" }, 409);
  const current = await currentAnswers(env, row.id);
  // A proposal left untouched is a choice: Auto, which hands the decision to the final research.
  const decisions = new Set(step.sections.flatMap((x) => x.questions.filter((q) => q.kind === "decision").map((q) => q.id)));
  const items = flatten(step.sections).map((q) => {
    const text = current[q.id]?.text ?? "";
    return { ...q, answer: decisions.has(q.id) && !text.trim() ? "Auto" : text, updatedAt: current[q.id]?.updatedAt ?? null };
  });
  const answered = items.filter((i) => i.answer.trim()).length;
  if (!answered) return json({ error: "no_saved_answers" }, 409);

  const prev = await env.DB.prepare("SELECT seq, step_n, payload FROM submissions WHERE case_id = ? ORDER BY seq DESC LIMIT 1").bind(row.id).first<any>();
  const before = new Map(parse<{ id: string; answer: string }[]>(prev?.payload ?? "[]", []).map((i) => [i.id, i.answer]));
  const changed = prev && prev.step_n === step.n ? items.filter((i) => (before.get(i.id) ?? "") !== i.answer).map((i) => i.id) : [];
  const payload = JSON.stringify(items);
  const hash = await sha256(payload);
  const seq = (prev?.seq ?? 0) + 1;
  const at = new Date().toISOString();
  try {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO submissions(case_id, seq, step_n, idem_key, submitted_at, answered, total, changed_json, payload, sha256) VALUES (?,?,?,?,?,?,?,?,?,?)")
        .bind(row.id, seq, step.n, key, at, answered, items.length, JSON.stringify(changed), payload, hash),
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
  const profiles = await env.DB.prepare("SELECT id, slug, name FROM profiles WHERE status = 'active' ORDER BY created_at").all<any>();
  const pages = await env.DB.prepare(`SELECT c.profile_id, c.slug, c.title, c.status, c.created_at, c.updated_at,
    (SELECT COALESCE(SUM(e.usd_micro), 0) FROM cost_entries e WHERE e.case_id = c.id) AS micro,
    EXISTS (SELECT 1 FROM reroutes r WHERE r.case_id = c.id AND r.handled_at IS NULL) AS rerouting,
    (SELECT questions_json FROM steps t WHERE t.case_id = c.id ORDER BY n DESC LIMIT 1) AS last_q
    FROM cases c WHERE c.status != 'draft' ORDER BY c.created_at`).all<any>();
  const kind = (q: string | null) => { const secs = parse<Section[]>(q ?? "[]", []); return secs.some((x) => x.questions.some((y) => y.kind === "decision")) ? "decisions" : secs.length ? "questions" : "final"; };
  return profiles.results.map((p) => ({
    slug: p.slug, name: p.name,
    pages: pages.results.filter((c) => c.profile_id === p.id).map((c) => ({ slug: c.slug, title: c.title, status: c.status, createdAt: c.created_at, updatedAt: c.updated_at, costUsd: c.micro / 1_000_000, rerouting: !!c.rerouting, lastKind: kind(c.last_q) })),
  })).filter((p) => p.pages.length);
}

async function pageApi(request: Request, env: Env, row: CaseRow, rest: string, ray: string) {
  const editable = (await signedIn(request, env))?.id === row.profile_id;
  if (rest === "" && request.method === "GET") {
    const [stepR, costR, rerouteR] = await env.DB.batch([
      env.DB.prepare("SELECT * FROM steps WHERE case_id = ? ORDER BY n").bind(row.id),
      env.DB.prepare("SELECT COALESCE(SUM(usd_micro), 0) AS micro FROM cost_entries WHERE case_id = ?").bind(row.id),
      env.DB.prepare("SELECT message, at FROM reroutes WHERE case_id = ? AND handled_at IS NULL ORDER BY id DESC LIMIT 1").bind(row.id),
    ]);
    const steps: Step[] = (stepR.results as any[]).map((x) => ({ n: x.n, title: x.title, intro: parse(x.intro_json, []), sections: parse<Section[]>(x.questions_json, []), plan: parse(x.plan_json, []), createdAt: x.created_at }));
    const open = answerStep(steps);
    // Answers and requested directions are private to the profile. Visitors get research, questions, status and cost.
    const pub = { title: row.title, name: row.p_name, profileSlug: row.p_slug, status: row.status, costUsd: ((costR.results[0] as any)?.micro ?? 0) / 1_000_000, editable, steps, openStep: open?.n ?? null, rerouting: !!rerouteR.results[0] };
    if (!editable) return json(pub);
    const subs = await env.DB.prepare("SELECT seq, step_n, submitted_at, payload FROM submissions WHERE case_id = ? ORDER BY seq").bind(row.id).all<any>();
    const logs: Record<string, unknown> = {};
    for (const x of subs.results) logs[x.step_n] = { seq: x.seq, submittedAt: x.submitted_at, items: parse(x.payload, []) };
    return json({ ...pub, reroute: rerouteR.results[0] ?? null, answers: await currentAnswers(env, row.id), submissions: await summaries(env, row.id), logs });
  }
  if (!(rest === "answers" && request.method === "PUT") && !((rest === "submit" || rest === "reroute") && request.method === "POST")) return notFound();
  if (!editable) return json({ error: "sign_in_required" }, 401);
  // A closed probe, or one whose final report is out, takes no more answers, decisions or new directions.
  if (row.status === "closed" || row.status === "plan_ready") return json({ error: "closed" }, 403);

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
      env.DB.prepare("UPDATE cases SET updated_at = ? WHERE id = ?").bind(at, row.id),
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
  const known = new Set(flatten(answerStep(await loadSteps(env, row.id))?.sections ?? []).map((q) => q.id));
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
  await env.DB.batch([
    ...entries.map(([id, text]) =>
      env.DB.prepare("INSERT INTO answers(case_id, question_id, text, updated_at) VALUES (?,?,?,?) ON CONFLICT(case_id, question_id) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at")
        .bind(row.id, id, text as string, updatedAt)),
    env.DB.prepare("UPDATE cases SET updated_at = ? WHERE id = ?").bind(updatedAt, row.id),
  ]);
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
    if (conf.admin_locked_until) await setSettings(env, { admin_fails: "0", admin_locked_until: "" });
    // Count the attempt first and atomically, so a burst of parallel guesses can't outrun the pause.
    const counted = await env.DB.prepare("INSERT INTO settings(key, value) VALUES ('admin_fails', '1') ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1 RETURNING value").first<{ value: string }>();
    const fails = Number(counted?.value ?? 1);
    const pause = () => setSettings(env, { admin_locked_until: new Date(now.getTime() + ADMIN_LOCK_MINUTES * 60_000).toISOString() });
    if (fails > ADMIN_MAX_FAILS) { await pause(); return json({ error: "locked" }, 429); }
    if (typeof b?.password !== "string" || (await sha256(conf.master_salt + b.password)) !== conf.master_hash) {
      log(env, ray, "warn", "admin_login_failed", { fails });
      if (fails === ADMIN_MAX_FAILS) { await pause(); return json({ error: "locked" }, 429); }
      return json({ error: "wrong_password" }, 401);
    }
    const token = randomToken();
    await setSettings(env, { admin_fails: "0", admin_locked_until: "" });
    await env.DB.batch([
      env.DB.prepare("INSERT INTO sessions(token_hash, case_id, pw_version, expires_at) VALUES (?,?,?,?)").bind(await sha256(token), ADMIN_SESSION, 0, new Date(now.getTime() + ADMIN_DAYS * 86_400_000).toISOString()),
      audit(env, null, "admin", "login", null, ray),
    ]);
    return json({ ok: true }, 200, { "Set-Cookie": `pp_admin=${token}; Path=/; Max-Age=${ADMIN_DAYS * 86_400}; HttpOnly; Secure; SameSite=Strict` });
  }
  if (!(await adminLoggedIn(request, env))) return json({ error: "login_required" }, 401);
  if (what === "logout" && request.method === "POST") {
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(readCookie(request, "pp_admin")!)).run();
    return json({ ok: true }, 200, { "Set-Cookie": "pp_admin=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict" });
  }
  if (what === "requests" && id) {
    if (sub === "files" && parts[3] && request.method === "GET") return downloadFile(env, id, parts[3]);
    if (!sub && request.method === "GET") { const q = await requestDetail(env, id); return q ? json(q) : json({ error: "not_found" }, 404); }
    if (!sub && request.method === "DELETE") { await deleteRequest(env, id, ray); return json({ ok: true }); }
    if (!sub && request.method === "POST") {
      const b = await request.json().catch(() => null) as { status?: string } | null;
      if (b?.status !== "approved" && b?.status !== "rejected") return json({ error: "bad_status" }, 400);
      await setRequestStatus(env, id, b.status, null, ray);
      return json({ ok: true });
    }
    return notFound();
  }
  if (what === "overview" && request.method === "GET") {
    const profiles = await env.DB.prepare(`SELECT p.id, p.name, p.slug, p.status, p.reason, p.created_at, p.password_hash IS NOT NULL AS has_password, (SELECT COUNT(*) FROM cases c WHERE c.profile_id = p.id) AS pages FROM profiles p ORDER BY p.created_at`).all();
    const stepRows = await env.DB.prepare("SELECT case_id, n, questions_json FROM steps ORDER BY n").all<any>();
    const totals = new Map<string, number>(), stepCount = new Map<string, number>(), openIds = new Map<string, Set<string>>(), lastKind = new Map<string, string>();
    for (const x of stepRows.results) {
      stepCount.set(x.case_id, (stepCount.get(x.case_id) ?? 0) + 1);
      const secs = parse<Section[]>(x.questions_json, []), qs = flatten(secs);
      if (qs.length) { totals.set(x.case_id, qs.length); openIds.set(x.case_id, new Set(qs.map((q) => q.id))); }
      lastKind.set(x.case_id, secs.some((s) => s.questions.some((q) => q.kind === "decision")) ? "decisions" : qs.length ? "questions" : "final");
    }
    // "Saved" counts only answers to the step people can answer now, so it can never exceed the total.
    const answered = await env.DB.prepare("SELECT case_id, question_id FROM answers WHERE trim(text) != ''").all<{ case_id: string; question_id: string }>();
    const savedNow = new Map<string, number>();
    for (const a of answered.results) if (openIds.get(a.case_id)?.has(a.question_id)) savedNow.set(a.case_id, (savedNow.get(a.case_id) ?? 0) + 1);
    const r = await env.DB.prepare(`SELECT c.id, c.title, c.status, c.updated_at, p.name AS profile, p.slug AS profile_slug, c.slug,
      (SELECT COUNT(*) FROM submissions s WHERE s.case_id = c.id) AS submissions,
      EXISTS (SELECT 1 FROM reroutes r WHERE r.case_id = c.id AND r.handled_at IS NULL) AS rerouting,
      (SELECT COALESCE(SUM(e.usd_micro), 0) / 1000000.0 FROM cost_entries e WHERE e.case_id = c.id) AS cost_usd
      FROM cases c JOIN profiles p ON p.id = c.profile_id ORDER BY c.created_at`).all<any>();
    const requests = await env.DB.prepare("SELECT r.id, r.name, r.title, r.status, r.created_at, (SELECT COUNT(*) FROM request_files f WHERE f.request_id = r.id) AS files FROM requests r ORDER BY CASE r.status WHEN 'new' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, r.created_at DESC LIMIT 100").all();
    return json({ pending: await pendingWork(env), requests: requests.results, profiles: profiles.results, pages: r.results.map((x) => ({ ...x, saved: savedNow.get(x.id) ?? 0, total: totals.get(x.id) ?? 0, steps: stepCount.get(x.id) ?? 1, lastKind: lastKind.get(x.id) ?? "final" })) });
  }
  if (what === "profiles" && !id && request.method === "POST") {
    const b = await request.json().catch(() => null) as { name?: unknown } | null;
    const name = typeof b?.name === "string" ? b.name.trim() : "";
    if (!name || name.length > 80) return json({ error: "bad_name" }, 400);
    const { match } = await findProfile(env, name);
    return json(match ?? await createProfile(env, name, new Date().toISOString()), 201);
  }
  if (what === "profiles" && id) {
    const profile = await profileOf(env, id);
    if (!profile) return json({ error: "not_found" }, 404);
    if (sub === "name" && request.method === "POST") {
      const b = await request.json().catch(() => null) as { name?: unknown } | null;
      const name = typeof b?.name === "string" ? tidyName(b.name) : "";
      if (name.length < 2 || name.length > 80) return json({ error: "bad_name" }, 400);
      const { match } = await findProfile(env, name);
      if (match && match.id !== id) return json({ error: "name_taken" }, 409);
      // The slug stays, so links that were already shared keep working.
      await env.DB.batch([
        env.DB.prepare("UPDATE profiles SET name = ? WHERE id = ?").bind(name, id),
        env.DB.prepare("UPDATE requests SET name = ? WHERE profile_id = ?").bind(name, id),
        audit(env, null, "admin", "profile_renamed", "profile=" + id, ray),
      ]);
      return json({ name });
    }
    if (sub === "status" && request.method === "POST") {
      const b = await request.json().catch(() => null) as { status?: unknown } | null;
      if (b?.status !== "active" && b?.status !== "rejected") return json({ error: "bad_status" }, 400);
      await setProfileStatus(env, id, b.status, ray);
      return json({ ok: true });
    }
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
    if (!sub && request.method === "DELETE") {
      const used = await env.DB.prepare("SELECT 1 FROM cases WHERE profile_id = ? LIMIT 1").bind(id).first();
      if (used) return json({ error: "has_pages" }, 409);
      await env.DB.batch([
        env.DB.prepare("DELETE FROM sessions WHERE case_id = ?").bind(id),
        env.DB.prepare("DELETE FROM profiles WHERE id = ?").bind(id),
        audit(env, null, "admin", "profile_deleted", id, ray),
      ]);
      return json({ ok: true });
    }
    return notFound();
  }
  if (what !== "pages" || !id) return notFound();
  const row = await env.DB.prepare("SELECT * FROM cases WHERE id = ?").bind(id).first<CaseRow>();
  if (!row) return json({ error: "not_found" }, 404);

  if (!sub && request.method === "DELETE") { await deleteCase(env, id, ray); return json({ ok: true }); }
  if (sub === "answers" && request.method === "PUT") {
    const b = await request.json().catch(() => null) as { answers?: Record<string, unknown> } | null;
    const known = new Set((await loadSteps(env, id)).flatMap((x) => flatten(x.sections).map((q) => q.id)));
    const entries = Object.entries(b?.answers ?? {});
    if (!entries.length || entries.some(([k, v]) => !known.has(k) || typeof v !== "string" || (v as string).length > MAX_ANSWER)) return json({ error: "bad_request" }, 400);
    const at = new Date().toISOString();
    await env.DB.batch([
      ...entries.map(([k, v]) => env.DB.prepare("INSERT INTO answers(case_id, question_id, text, updated_at) VALUES (?,?,?,?) ON CONFLICT(case_id, question_id) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at").bind(id, k, v as string, at)),
      env.DB.prepare("UPDATE cases SET updated_at = ? WHERE id = ?").bind(at, id),
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
      title: row.title, profile: p?.name, status: row.status, steps: await loadSteps(env, id), answers: await currentAnswers(env, id),
      reroute: await openReroute(env, id), costUsd: await costUsd(env, id), audit: auditRows.results,
      costs: costs.results.map((c) => ({ usd: c.usd_micro / 1_000_000, label: c.label, at: c.at })),
      submissions: await Promise.all(subs.results.map(async (s) => ({ seq: s.seq, stepN: s.step_n, submittedAt: s.submitted_at, answered: s.answered, total: s.total, intact: (await sha256(s.payload)) === s.sha256, items: parse(s.payload, null) }))),
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
  if (root === "pending" && request.method === "GET") return json({ pending: await pendingWork(env) });
  if (root === "requests") {
    if (!id && request.method === "GET") return json({ requests: (await env.DB.prepare("SELECT id, name, title, status, created_at FROM requests ORDER BY created_at DESC LIMIT 100").all()).results });
    if (id && sub === "files" && which && request.method === "GET") return downloadFile(env, id, which);
    if (id && !sub && request.method === "GET") { const q = await requestDetail(env, id); return q ? json(q) : json({ error: "not_found" }, 404); }
    if (id && !sub && request.method === "POST") {
      const b = await request.json().catch(() => null) as { status?: string; caseId?: string } | null;
      if (!["approved", "rejected", "started"].includes(b?.status ?? "")) return json({ error: "bad_status" }, 400);
      await setRequestStatus(env, id, b!.status!, b!.caseId ?? null, ray);
      return json({ ok: true });
    }
    return notFound();
  }
  if (root === "profiles" && (request.method === "GET" || request.method === "POST")) {
    if (id && (sub === "approve" || sub === "reject")) {
      const { match } = await findProfile(env, decodeURIComponent(id));
      if (!match) return json({ error: "not_found" }, 404);
      await setProfileStatus(env, match.id, sub === "approve" ? "active" : "rejected", ray);
      return json({ ok: true });
    }
    const r = await env.DB.prepare("SELECT p.name, p.slug, p.status, p.reason, p.password_hash IS NOT NULL AS has_password, (SELECT COUNT(*) FROM cases c WHERE c.profile_id = p.id) AS pages FROM profiles p ORDER BY p.created_at").all();
    return json({ profiles: r.results });
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
    const b = await request.json().catch(() => null) as { title?: string; profile?: string; create?: boolean } | null;
    if (!b?.title || !b.profile) return json({ error: "title and profile required" }, 400);
    const caseId = crypto.randomUUID().slice(0, 8);
    const { match, names } = await findProfile(env, b.profile);
    if (!match && !b.create) return json({ error: "unknown_profile", profiles: names }, 404);
    const p = match ?? await createProfile(env, b.profile, now);
    const slug = await freeSlug(env, "cases", slugify(b.title), p.id);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO cases(id, token_hash, title, first_name, profile_id, slug, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)").bind(caseId, await sha256(randomToken()), b.title, p.name, p.id, slug, now, now),
      env.DB.prepare("INSERT INTO steps(case_id, n, title, created_at) VALUES (?,1,?,?)").bind(caseId, FIRST_STEP, now),
      audit(env, caseId, "admin", "create", null, ray),
    ]);
    return json({ id: caseId, path: `/probes/${p.slug}/${slug}`, profile: p.name, profileCreated: !match }, 201);
  }
  if (!id) return notFound();
  const row = await env.DB.prepare("SELECT * FROM cases WHERE id = ?").bind(id).first<CaseRow>();
  if (!row) return json({ error: "not_found" }, 404);

  if (!sub && request.method === "GET") {
    const p = await env.DB.prepare("SELECT slug, name FROM profiles WHERE id = ?").bind(row.profile_id).first<any>();
    const steps = await loadSteps(env, id), open = answerStep(steps), submissions = await summariesWithStep(env, id), last = submissions[submissions.length - 1];
    return json({ id: row.id, title: row.title, profile: p?.name, path: `/probes/${p?.slug}/${row.slug}`, status: row.status, hasPassword: !!(await profileOf(env, row.profile_id))?.password_hash, costUsd: await costUsd(env, id), reroute: await openReroute(env, id), steps, openStep: open?.n ?? null, sections: open?.sections ?? [], submissionCurrent: !!last && !!open && last.stepN === open.n, answers: await currentAnswers(env, id), submissions });
  }
  if (!sub && request.method === "PATCH") {
    const b = await request.json().catch(() => null) as { intro?: unknown; questions?: unknown; plan?: unknown; status?: string; newStep?: unknown; step?: unknown; stepTitle?: unknown } | null;
    if (!b) return json({ error: "bad_request" }, 400);
    if (b.questions !== undefined && !validSections(b.questions)) return json({ error: "invalid_questions" }, 400);
    if (b.intro !== undefined && !validBlocks(b.intro)) return json({ error: "invalid_intro" }, 400);
    if (b.plan !== undefined && !validBlocks(b.plan)) return json({ error: "invalid_plan" }, 400);
    if (b.status !== undefined && !STATUSES.includes(b.status)) return json({ error: "invalid_status" }, 400);
    if (b.newStep !== undefined && (typeof b.newStep !== "string" || !b.newStep.trim())) return json({ error: "invalid_step_title" }, 400);
    if (b.stepTitle !== undefined && (typeof b.stepTitle !== "string" || !b.stepTitle.trim() || b.stepTitle.length > 80 || b.newStep !== undefined)) return json({ error: "invalid_step_title" }, 400);
    const steps = await loadSteps(env, id), latest = steps[steps.length - 1], changesContent = b.intro !== undefined || b.questions !== undefined || b.plan !== undefined;
    const rerouted = await openReroute(env, id);
    const size = (x: unknown) => JSON.stringify(x ?? []).length;
    if (size(b.intro) + size(b.questions) + size(b.plan) > MAX_DOC) return json({ error: "too_large" }, 413);
    const writes: D1PreparedStatement[] = [];
    if (typeof b.stepTitle === "string") {
      const target = b.step === undefined ? latest : steps.find((x) => x.n === b.step);
      if (!target) return json({ error: "unknown_step" }, 404);
      writes.push(env.DB.prepare("UPDATE steps SET title = ? WHERE case_id = ? AND n = ?").bind(b.stepTitle.trim(), id, target.n));
    }
    if (typeof b.newStep === "string") {
      writes.push(env.DB.prepare("INSERT INTO steps(case_id, n, title, intro_json, questions_json, plan_json, created_at) VALUES (?,?,?,?,?,?,?)")
        .bind(id, latest.n + 1, b.newStep.trim(), JSON.stringify(b.intro ?? []), JSON.stringify(b.questions ?? []), JSON.stringify(b.plan ?? []), now));
    } else if (changesContent) {
      const target = b.step === undefined ? latest : steps.find((x) => x.n === b.step);
      if (!target) return json({ error: "unknown_step" }, 404);
      // New research must never overwrite what people already responded to.
      const answered = await env.DB.prepare("SELECT 1 FROM submissions WHERE case_id = ? AND step_n = ? LIMIT 1").bind(id, target.n).first();
      if (b.step === undefined && (answered || rerouted)) return json({ error: "use_new_step" }, 409);
      writes.push(env.DB.prepare("UPDATE steps SET intro_json = ?, questions_json = ?, plan_json = ? WHERE case_id = ? AND n = ?")
        .bind(JSON.stringify(b.intro ?? target.intro), JSON.stringify(b.questions ?? target.sections), JSON.stringify(b.plan ?? target.plan), id, target.n));
    }
    const closesReroute = !!rerouted && (typeof b.newStep === "string" || b.questions !== undefined);
    if (closesReroute) writes.push(env.DB.prepare("UPDATE reroutes SET handled_at = ? WHERE case_id = ? AND handled_at IS NULL").bind(now, id));
    await env.DB.batch([
      ...writes,
      env.DB.prepare("UPDATE cases SET status = ?, updated_at = ? WHERE id = ?").bind(b.status ?? (closesReroute || (typeof b.newStep === "string" && validSections(b.questions) && b.questions.length) ? "open" : row.status), now, id),
      audit(env, id, "admin", "update", Object.keys(b).join(","), ray),
    ]);
    return json({ ok: true });
  }
  if (sub === "import" && request.method === "POST") {
    // Answers collected somewhere else become a normal submission.
    const b = await request.json().catch(() => null) as { answers?: Record<string, unknown> } | null;
    const known = new Set(flatten(answerStep(await loadSteps(env, id))?.sections ?? []).map((q) => q.id));
    const entries = Object.entries(b?.answers ?? {});
    if (!entries.length || entries.some(([k, v]) => !known.has(k) || typeof v !== "string" || (v as string).length > MAX_ANSWER)) return json({ error: "bad_answers" }, 400);
    await env.DB.batch([
      ...entries.map(([k, v]) => env.DB.prepare("INSERT INTO answers(case_id, question_id, text, updated_at) VALUES (?,?,?,?) ON CONFLICT(case_id, question_id) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at").bind(id, k, v as string, now)),
      audit(env, id, "admin", "answers_imported", String(entries.length), ray),
    ]);
    return submit(env, row, "import-" + randomToken().slice(0, 16), ray);
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
  if (!sub && request.method === "DELETE") { await deleteCase(env, id, ray); return json({ ok: true }); }
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
      if (parts[0] === "assets" && parts[1] === "account.js" && page) return new Response(ACCOUNT, { headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "public, max-age=300", "X-Content-Type-Options": "nosniff" } });
      if (parts[0] === "probes" && (parts.length === 1 || parts.length === 3) && page) return html(APP, request);
      if (parts[0] === "admin" && parts.length === 1 && page) return html(ADMIN, request);
      if (parts[0] === "request" && parts.length === 1 && page) return html(REQUEST, request);
      if (!schemaReady) { if (!(await schemaCurrent(env))) await migrate(env); schemaReady = true; }
      if (parts[0] === "api" && parts[1] === "admin") return await adminSite(request, env, parts.slice(2), ray);
      if (parts[0] === "admin") return await admin(request, env, parts.slice(1), ray);
      if (parts[0] !== "api") return notFound();
      // Browsers send Origin on cross-site writes. Refusing a foreign one blocks forged forms, including sign-in.
      const origin = request.headers.get("Origin");
      if (request.method !== "GET" && origin && origin !== url.origin) return json({ error: "bad_origin" }, 403);
      if (parts[1] === "requests" && parts.length === 2 && request.method === "POST") return await createRequest(request, env, ray);
      if (parts[1] === "profiles" && parts.length === 2 && request.method === "POST") return await applyForProfile(request, env, ray);
      if (parts[1] === "session" && parts[2] === "password" && parts.length === 3 && request.method === "POST") return await changePassword(request, env, ray);
      if (parts[1] === "session" && parts.length === 2) {
        if (request.method === "GET") { const me = await signedIn(request, env); return json(me ? { signedIn: true, name: me.name, slug: me.slug } : { signedIn: false }); }
        if (request.method === "POST") return await signIn(request, env, ray);
        if (request.method === "DELETE") return await signOut(request, env);
      }
      if (parts[1] === "probes" && parts.length === 2 && page) return json({ profiles: await directory(env) });
      if (parts[1] === "pages" && parts[2] && parts[3]) {
        const row = await env.DB.prepare("SELECT c.*, p.name AS p_name, p.slug AS p_slug FROM cases c JOIN profiles p ON p.id = c.profile_id WHERE p.slug = ? AND c.slug = ? AND c.status != 'draft' AND p.status = 'active'").bind(parts[2], parts[3]).first<CaseRow>();
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
