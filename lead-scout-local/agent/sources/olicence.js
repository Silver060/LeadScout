// Traffic Commissioner goods operator licence data - the strongest fleet signal available.
// The DVSA publishes operator licence data as downloadable CSV snapshots (data.gov.uk,
// "Traffic Commissioners goods and public service vehicle operator licence records").
// Strategy: load the current snapshot, diff against last week's local copy, and emit
// signals for fleet increases and new operating centres. 100% authoritative, pre-press.
//
// Prefer OLICENCE_CSV_DIR for offline regional CSV files. OLICENCE_CSV_URL remains a
// backwards-compatible fallback when no local directory is configured.
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join, resolve, basename } from "path";

const dataDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "data");
const SNAPSHOT = join(dataDir, "olicence-snapshot.json");

export function parseCsv(text) {
  // Minimal CSV parse (handles quoted fields). Good enough for the published format.
  const rows = [];
  let row = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQ = false;
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (field || row.length) { row.push(field); rows.push(row); row = []; field = ""; }
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// Column names in the published CSVs vary slightly; match loosely.
function col(header, ...names) {
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
  const lower = header.map((h) => norm(h));
  for (const n of names) {
    const needle = norm(n);
    const i = lower.findIndex((h) => h.includes(needle));
    if (i >= 0) return i;
  }
  return -1;
}

function sourceLabel(source) {
  return source?.trafficArea || source?.filename || source?.url || "unknown source";
}

function mergeText(a, b) {
  const av = String(a || "").trim();
  const bv = String(b || "").trim();
  if (!av) return bv;
  if (!bv || av.toLowerCase() === bv.toLowerCase()) return av;
  return `${av} / ${bv}`;
}

function mergeNumber(a, b) {
  const an = Number(a) || 0;
  const bn = Number(b) || 0;
  return Math.max(an, bn);
}

function mergeCentres(a, b) {
  if (a == null) return b;
  if (b == null) return a;
  return Math.max(Number(a) || 0, Number(b) || 0);
}

function extractTrafficArea(filename) {
  return basename(filename, ".csv")
    .replace(/^goods[-_\s]*/i, "")
    .replace(/[-_]+/g, " ")
    .trim() || basename(filename);
}

function normaliseRecord(record) {
  return {
    ...record,
    name: String(record.name || "").trim(),
    licence: String(record.licence || "").trim(),
    vehicles: Number(record.vehicles) || 0,
    centres: record.centres == null ? null : Number(record.centres) || 0,
    sources: [...new Set(record.sources || [])].sort(),
    trafficAreas: [...new Set(record.trafficAreas || [])].sort(),
  };
}

function mergeRecord(existing, incoming) {
  const merged = normaliseRecord({
    name: mergeText(existing.name, incoming.name),
    licence: existing.licence || incoming.licence,
    vehicles: mergeNumber(existing.vehicles, incoming.vehicles),
    centres: mergeCentres(existing.centres, incoming.centres),
    sources: [...(existing.sources || []), ...(incoming.sources || [])],
    trafficAreas: [...(existing.trafficAreas || []), ...(incoming.trafficAreas || [])],
  });
  merged.duplicate_count = (existing.duplicate_count || 0) + 1;
  return merged;
}

function parseLicenceRows(text, source) {
  const rows = parseCsv(text);
  const header = rows[0] || [];
  const iName = col(header, "operator name", "organisation");
  const iVeh = col(header, "authorised vehicle", "vehicles authorised", "vehicle authorisation");
  const iCentres = col(header, "operating centre", "centres");
  const iLic = col(header, "licence number", "licence");
  if (iName < 0 || iVeh < 0 || iLic < 0) {
    throw new Error(`unrecognised CSV headers in ${sourceLabel(source)}: ${header.join(" | ")}`);
  }

  const parsed = [];
  for (const r of rows.slice(1)) {
    const licence = String(r[iLic] || "").trim();
    if (!licence) continue;
    parsed.push(normaliseRecord({
      name: r[iName],
      licence,
      vehicles: r[iVeh],
      centres: iCentres >= 0 ? r[iCentres] : null,
      sources: [source.filename || source.url || sourceLabel(source)],
      trafficAreas: source.trafficArea ? [source.trafficArea] : [],
    }));
  }
  return { records: parsed, rowCount: Math.max(0, rows.length - 1) };
}

function combineRecords(parts) {
  const current = {};
  let duplicateCount = 0;
  let totalRows = 0;

  for (const part of parts) {
    totalRows += part.rowCount;
    for (const record of part.records) {
      const key = record.licence;
      if (current[key]) {
        current[key] = mergeRecord(current[key], record);
        duplicateCount++;
      } else {
        current[key] = record;
      }
    }
  }

  return { current, totalRows, duplicateCount };
}

export function loadFromDirectory(dir) {
  const resolvedDir = resolve(dir);
  if (!existsSync(resolvedDir)) {
    throw new Error(`OLICENCE_CSV_DIR does not exist: ${resolvedDir}`);
  }
  if (!statSync(resolvedDir).isDirectory()) {
    throw new Error(`OLICENCE_CSV_DIR is not a directory: ${resolvedDir}`);
  }

  const files = readdirSync(resolvedDir)
    .filter((name) => name.toLowerCase().endsWith(".csv"))
    .sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));

  if (!files.length) {
    throw new Error(`no CSV files found in OLICENCE_CSV_DIR: ${resolvedDir}`);
  }

  const parts = files.map((filename) => {
    const path = join(resolvedDir, filename);
    let text;
    try {
      text = readFileSync(path, "utf8");
    } catch (e) {
      throw new Error(`unable to read ${path}: ${e.message}`);
    }
    return parseLicenceRows(text, {
      filename,
      trafficArea: extractTrafficArea(filename),
    });
  });

  return { ...combineRecords(parts), fileCount: files.length, mode: "local", directory: resolvedDir };
}

async function loadFromUrl(url) {
  let text;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`download ${res.status}`);
    text = await res.text();
  } catch (e) {
    throw new Error(`download failed: ${e.message}`);
  }

  const part = parseLicenceRows(text, { url });
  return { ...combineRecords([part]), fileCount: 1, mode: "url", url };
}

export function buildChangeSignals(config, current, prev, today = new Date().toISOString().slice(0, 10)) {
  const signals = [];
  for (const [key, cur] of Object.entries(current)) {
    const old = prev.data?.[key];
    if (!old) continue; // new licences are noisy; focus on growth of existing operators
    const minJump = config.olicence?.minVehicleIncrease ?? 3;
    if (cur.vehicles - old.vehicles >= minJump) {
      signals.push({
        source: "olicence", type: "fleet_expansion",
        company_name: cur.name,
        signal_summary: `Authorised fleet increased from ${old.vehicles} to ${cur.vehicles} vehicles (O-licence register, snapshot ${prev.date} to ${today})`,
        signal_date: today,
        evidence: [{ url: "https://www.vehicle-operator-licensing.service.gov.uk/search", title: "DVSA operator licence register (search operator name)", date: today }],
      });
    }
    if (old.centres != null && cur.centres != null && cur.centres > old.centres) {
      signals.push({
        source: "olicence", type: "new_depot",
        company_name: cur.name,
        signal_summary: `Operating centres increased from ${old.centres} to ${cur.centres} (new depot) - O-licence register`,
        signal_date: today,
        evidence: [{ url: "https://www.vehicle-operator-licensing.service.gov.uk/search", title: "DVSA operator licence register (search operator name)", date: today }],
      });
    }
  }
  return signals;
}

export async function findCandidates(config, log, { persist = true } = {}) {
  const dir = process.env.OLICENCE_CSV_DIR;
  const url = process.env.OLICENCE_CSV_URL;
  if (!dir && !url) {
    log("olicence", "skipped - no OLICENCE_CSV_DIR or OLICENCE_CSV_URL set");
    return [];
  }
  mkdirSync(dataDir, { recursive: true });

  let loaded;
  try {
    if (dir) {
      if (url) log("olicence", "using local offline CSV files from OLICENCE_CSV_DIR; OLICENCE_CSV_URL ignored");
      loaded = loadFromDirectory(dir);
    } else {
      loaded = await loadFromUrl(url);
    }
  } catch (e) {
    log.error("olicence", e.message);
    return [];
  }

  const { current, fileCount, totalRows, duplicateCount } = loaded;
  const uniqueLicences = Object.keys(current).length;

  const signals = [];
  if (existsSync(SNAPSHOT)) {
    const prev = JSON.parse(readFileSync(SNAPSHOT, "utf8"));
    const today = new Date().toISOString().slice(0, 10);
    signals.push(...buildChangeSignals(config, current, prev, today));
    log("olicence", `${signals.length} change signals vs snapshot of ${prev.date}`);
  } else {
    log("olicence", persist
      ? "first run - snapshot saved, diffs start next week"
      : "first run (dry run) - snapshot not saved");
  }
  log("olicence", `summary: ${fileCount} CSV file${fileCount === 1 ? "" : "s"} read, ${totalRows} rows parsed, ${uniqueLicences} unique licences loaded, ${duplicateCount} duplicate licence${duplicateCount === 1 ? "" : "s"} merged, ${signals.length} change signals produced`);
  if (persist) {
    writeFileSync(SNAPSHOT, JSON.stringify({
      date: new Date().toISOString().slice(0, 10),
      data: current,
    }));
  }
  return signals;
}
