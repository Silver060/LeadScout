// Local SQLite database (built into Node 22+, nothing to install).
// Data lives in data/leadscout.db — back it up by copying that one file.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "fs";
import { randomUUID } from "crypto";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const dataDir = join(dirname(fileURLToPath(import.meta.url)), "..", "data");
mkdirSync(dataDir, { recursive: true });

const sqlite = new DatabaseSync(join(dataDir, "leadscout.db"));
sqlite.exec(`
create table if not exists runs (
  id text primary key,
  trigger_type text not null default 'manual',
  status text not null default 'running',
  started_at text not null default (datetime('now')),
  finished_at text,
  queries_executed integer default 0,
  candidates_found integer default 0,
  leads_accepted integer default 0,
  error_message text,
  log text default '',
  email_sent integer default 0
);
create table if not exists leads (
  id text primary key,
  run_id text,
  company_name text not null,
  company_name_normalized text not null,
  website text,
  signal_summary text not null,
  signal_date text,
  why_warm text,
  confidence text not null,
  uncertainty_notes text,
  evidence text default '[]',
  contact_name text, contact_role text, contact_email text, contact_source text,
  suggested_angle text,
  pitch_subject text, pitch_body text,
  status text not null default 'new',
  status_updated_at text,
  notes text default '',
  created_at text not null default (datetime('now'))
);
create index if not exists leads_norm_idx on leads (company_name_normalized);
create table if not exists rejected_leads (
  id text primary key,
  run_id text,
  company_name_normalized text not null,
  reason text,
  created_at text not null default (datetime('now'))
);
`);

export function normalizeName(name) {
  return name
    .toLowerCase()
    .replace(/\b(ltd|limited|llp|plc|holdings|group|&\s*co\.?|company)\b/g, "")
    .replace(/[^a-z0-9]/g, "")
    .trim();
}

export async function startRun(trigger) {
  sqlite.prepare(`update runs set status='failed', error_message='stale (never finished)'
    where status='running' and started_at < datetime('now','-2 hours')`).run();
  const active = sqlite.prepare(`select id from runs where status='running' limit 1`).get();
  if (active) throw new Error(`A run is already in progress (${active.id}). Aborting.`);
  const id = randomUUID();
  sqlite.prepare(`insert into runs (id, trigger_type) values (?, ?)`).run(id, trigger);
  return { id, candidates_found: 0 };
}

export async function finishRun(runId, patch) {
  const cols = { finished_at: new Date().toISOString(), ...patch };
  if ("email_sent" in cols) cols.email_sent = cols.email_sent ? 1 : 0;
  const keys = Object.keys(cols);
  sqlite.prepare(`update runs set ${keys.map((k) => `${k}=?`).join(", ")} where id=?`)
    .run(...keys.map((k) => cols[k]), runId);
}

export async function knownCompanies(resurfaceAfterDays) {
  const set = new Set();
  for (const r of sqlite.prepare(`select company_name_normalized from leads`).all())
    set.add(r.company_name_normalized);
  for (const r of sqlite.prepare(
    `select company_name_normalized from rejected_leads where created_at > datetime('now', ?)`
  ).all(`-${resurfaceAfterDays} days`))
    set.add(r.company_name_normalized);
  return set;
}

export async function saveLead(lead) {
  const { run_id, ...rest } = lead;
  const row = { id: randomUUID(), run_id: run_id || null, ...rest, evidence: JSON.stringify(lead.evidence || []) };
  const keys = Object.keys(row);
  sqlite.prepare(`insert into leads (${keys.join(",")}) values (${keys.map(() => "?").join(",")})`)
    .run(...keys.map((k) => row[k]));
}

export async function saveRejection(runId, nameNorm, reason) {
  sqlite.prepare(`insert into rejected_leads (id, run_id, company_name_normalized, reason) values (?,?,?,?)`)
    .run(randomUUID(), runId, nameNorm, reason);
}

// --- Tracker queries (sync, used by the local web server) ---
export function listLeads() {
  return sqlite.prepare(`select * from leads order by created_at desc limit 300`).all()
    .map((l) => ({ ...l, evidence: JSON.parse(l.evidence || "[]") }));
}
export function lastRun() {
  return sqlite.prepare(`select * from runs order by started_at desc limit 1`).get() || null;
}
export function updateLead(id, { status, notes }) {
  if (status && ["new", "contacted", "replied", "ignored"].includes(status))
    sqlite.prepare(`update leads set status=?, status_updated_at=datetime('now') where id=?`).run(status, id);
  if (typeof notes === "string")
    sqlite.prepare(`update leads set notes=? where id=?`).run(notes.slice(0, 2000), id);
}
