import PAGE from "./page.html";
import { SCHEMA } from "./schema";

export interface Env { DB: D1Database; APP_VERSION: string; ADMIN_TOKEN_SHA256: string }

let schemaReady = false;
const MAX_ANSWER = 30_000;
const MAX_DOC = 300_000;
const STATUSES = ["draft", "open", "submitted", "plan_ready", "closed"];

const SEC: Record<string, string> = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};
const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...SEC, "Content-Type": "application/json; charset=utf-8" } });
const notFound = () => new Response("Not found", { status: 404, headers: { ...SEC, "Content-Type": "text/plain" } });

async function sha256(text: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const randomToken = () => {
  const b = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const parse = <T,>(s: string, fallback: T): T => { try { return JSON.parse(s) as T; } catch { return fallback; } };

// Field contract from the platform guide. Answer text and tokens are never logged.
function log(env: Env, ray: string, level: string, msg: string, extra: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ app: "proofprobe", version: env.APP_VERSION, ray_id: ray, level, msg, ...extra }));
}

interface Question { id: string; text: string; why?: string }
interface Section { title: string; note?: string; first?: boolean; questions: Question[] }
interface CaseRow { id: string; title: string; first_name: string; status: string; intro_json: string; questions_json: string; plan_json: string; created_at: string; updated_at: string }

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
const TONES = ["good", "warn", "bad", "info"];
const isCell = (c: any) => typeof c === "string" || (typeof c?.text === "string" && (c.tone === undefined || TONES.includes(c.tone)));
function validBlock(b: any): boolean {
  if (b?.t === "section") return typeof b.title === "string" && Array.isArray(b.blocks) && b.blocks.every(validBlock);
  if (["h2", "h3", "p", "callout"].includes(b?.t)) return typeof b.text === "string";
  if (b?.t === "ul" || b?.t === "ol") return isStrings(b.items);
  if (b?.t === "table") return isStrings(b.head) && Array.isArray(b.rows) && b.rows.every((r: unknown) => Array.isArray(r) && r.every(isCell));
  if (b?.t === "links") return Array.isArray(b.links) && b.links.every((k: any) => typeof k?.url === "string");
  return false;
}
const validBlocks = (v: unknown) => Array.isArray(v) && v.every(validBlock);

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
      audit(env, row.id, "respondent", "submit", `seq=${seq} answered=${answered}`, ray),
    ]);
  } catch (e) {
    log(env, ray, "warn", "submit_conflict", { case_id: row.id });
    return json({ error: "conflict" }, 503);
  }
  log(env, ray, "info", "submitted", { case_id: row.id, seq, answered });
  return json({ seq, submittedAt: at, answered, total: items.length, changed });
}

async function respondent(request: Request, env: Env, row: CaseRow, rest: string, ray: string) {
  if (rest === "" && (request.method === "GET" || request.method === "HEAD"))
    return new Response(request.method === "HEAD" ? null : PAGE, { headers: { ...SEC, "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": CSP } });

  if (rest === "api/case" && request.method === "GET") {
    return json({
      title: row.title, firstName: row.first_name, status: row.status,
      intro: parse(row.intro_json, []), sections: parse(row.questions_json, []), plan: parse(row.plan_json, []),
      answers: await currentAnswers(env, row.id), submissions: await summaries(env, row.id),
      costUsd: await costUsd(env, row.id),
    });
  }
  if (rest === "api/group" && request.method === "GET") {
    const r = await env.DB.prepare(`SELECT c.id, c.first_name, c.title, c.status,
      (SELECT COALESCE(SUM(e.usd_micro), 0) FROM cost_entries e WHERE e.case_id = c.id) AS micro
      FROM cases c WHERE c.status != 'draft' OR c.id = ? ORDER BY c.created_at`).bind(row.id).all();
    return json({ people: r.results.map((x: any) => ({ id: x.id, firstName: x.first_name, title: x.title, status: x.status, costUsd: x.micro / 1_000_000, mine: x.id === row.id })) });
  }
  const view = rest.match(/^api\/view\/([\w-]{1,40})$/);
  if (view && request.method === "GET") {
    const other = await env.DB.prepare("SELECT * FROM cases WHERE id = ?").bind(view[1]).first<CaseRow>();
    if (!other) return json({ error: "not_found" }, 404);
    // Read only, and only submitted answers: drafts stay private until that person submits.
    const last = await env.DB.prepare("SELECT seq, submitted_at, payload FROM submissions WHERE case_id = ? ORDER BY seq DESC LIMIT 1").bind(other.id).first<any>();
    return json({ title: other.title, firstName: other.first_name, status: other.status, intro: parse(other.intro_json, []), plan: parse(other.plan_json, []), costUsd: await costUsd(env, other.id),
      submittedAt: last?.submitted_at ?? null, seq: last?.seq ?? null,
      items: last ? parse(last.payload, []) : flatten(parse<Section[]>(other.questions_json, [])).map((q) => ({ ...q, answer: "" })) });
  }
  if (rest === "api/answers" && request.method === "PUT") {
    if (row.status === "closed") return json({ error: "closed" }, 403);
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
  if (rest === "api/submit" && request.method === "POST") {
    if (row.status === "closed") return json({ error: "closed" }, 403);
    const body = await request.json().catch(() => null) as { key?: unknown } | null;
    if (typeof body?.key !== "string" || !/^[\w-]{8,64}$/.test(body.key)) return json({ error: "bad_request" }, 400);
    return submit(env, row, body.key, ray);
  }
  return notFound();
}

async function admin(request: Request, env: Env, parts: string[], ray: string) {
  const auth = request.headers.get("Authorization") ?? "";
  if (!env.ADMIN_TOKEN_SHA256 || !auth.startsWith("Bearer ") || (await sha256(auth.slice(7))) !== env.ADMIN_TOKEN_SHA256) return notFound();
  const [root, id, sub, which] = parts;
  if (root !== "cases") return notFound();
  const now = new Date().toISOString();

  if (!id && request.method === "GET") {
    const r = await env.DB.prepare("SELECT c.id, c.title, c.first_name, c.status, c.updated_at, (SELECT COUNT(*) FROM submissions s WHERE s.case_id = c.id) AS submissions, (SELECT COALESCE(SUM(e.usd_micro), 0) / 1000000.0 FROM cost_entries e WHERE e.case_id = c.id) AS cost_usd FROM cases c ORDER BY c.created_at").all();
    return json({ cases: r.results });
  }
  if (!id && request.method === "POST") {
    const b = await request.json().catch(() => null) as { title?: string; firstName?: string } | null;
    if (!b?.title || !b.firstName) return json({ error: "title and firstName required" }, 400);
    const caseId = crypto.randomUUID().slice(0, 8);
    const token = randomToken();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO cases(id, token_hash, title, first_name, created_at, updated_at) VALUES (?,?,?,?,?,?)").bind(caseId, await sha256(token), b.title, b.firstName, now, now),
      audit(env, caseId, "admin", "create", null, ray),
    ]);
    return json({ id: caseId, token }, 201);
  }
  if (!id) return notFound();
  const row = await env.DB.prepare("SELECT * FROM cases WHERE id = ?").bind(id).first<CaseRow>();
  if (!row) return json({ error: "not_found" }, 404);

  if (!sub && request.method === "GET") {
    return json({ id: row.id, title: row.title, firstName: row.first_name, status: row.status, costUsd: await costUsd(env, id), sections: parse(row.questions_json, []), answers: await currentAnswers(env, id), submissions: await summaries(env, id) });
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
  if (sub === "rotate" && request.method === "POST") {
    const token = randomToken();
    await env.DB.batch([
      env.DB.prepare("UPDATE cases SET token_hash = ?, updated_at = ? WHERE id = ?").bind(await sha256(token), now, id),
      audit(env, id, "admin", "rotate", null, ray),
    ]);
    return json({ token });
  }
  if (!sub && request.method === "DELETE") {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM answers WHERE case_id = ?").bind(id),
      env.DB.prepare("DELETE FROM cost_entries WHERE case_id = ?").bind(id),
      env.DB.prepare("DELETE FROM submissions WHERE case_id = ?").bind(id),
      env.DB.prepare("DELETE FROM cases WHERE id = ?").bind(id),
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
    try {
      if (!schemaReady) { await env.DB.batch(SCHEMA.map((q) => env.DB.prepare(q))); schemaReady = true; }
      if (parts[0] === "admin") return await admin(request, env, parts.slice(1), ray);
      if (parts[0] !== "c" || !parts[1]) return notFound();
      const row = await env.DB.prepare("SELECT * FROM cases WHERE token_hash = ?").bind(await sha256(parts[1])).first<CaseRow>();
      if (!row) return notFound();
      return await respondent(request, env, row, parts.slice(2).join("/"), ray);
    } catch (e) {
      log(env, ray, "error", "unhandled", { error: String(e) });
      return json({ error: "server_error", ray_id: ray }, 500);
    }
  },
};
