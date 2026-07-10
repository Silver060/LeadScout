// Traffic Commissioner goods operator licence data — the strongest fleet signal available.
// The DVSA publishes operator licence data as downloadable CSV snapshots (data.gov.uk,
// "Traffic Commissioners goods and public service vehicle operator licence records").
// Strategy: download the current snapshot, diff against last week's local copy, and emit
// signals for fleet increases and new operating centres. 100% authoritative, pre-press.
//
// Set OLICENCE_CSV_URL in .env to the current published CSV URL (it changes occasionally;
// find it at data.gov.uk by searching "operator licence"). If unset, this source is skipped.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const dataDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "data");
const SNAPSHOT = join(dataDir, "olicence-snapshot.json");

function parseCsv(text) {
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
  const lower = header.map((h) => h.toLowerCase().trim());
  for (const n of names) {
    const i = lower.findIndex((h) => h.includes(n));
    if (i >= 0) return i;
  }
  return -1;
}

export async function findCandidates(config, log) {
  const url = process.env.OLICENCE_CSV_URL;
  if (!url) {
    log("olicence", "skipped — no OLICENCE_CSV_URL set");
    return [];
  }
  mkdirSync(dataDir, { recursive: true });
  let text;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`download ${res.status}`);
    text = await res.text();
  } catch (e) {
    log.error("olicence", `download failed: ${e.message}`);
    return [];
  }

  const rows = parseCsv(text);
  const header = rows[0] || [];
  const iName = col(header, "operator name", "organisation");
  const iVeh = col(header, "authorised vehicle", "vehicles authorised", "vehicle authorisation");
  const iCentres = col(header, "operating centre", "centres");
  const iLic = col(header, "licence number", "licence");
  if (iName < 0 || iVeh < 0) {
    log.error("olicence", `unrecognised CSV columns: ${header.join(" | ")}`);
    return [];
  }

  const current = {};
  for (const r of rows.slice(1)) {
    const key = (r[iLic] >= 0 ? r[iLic] : r[iName]) || r[iName];
    if (!key) continue;
    current[key] = {
      name: r[iName],
      vehicles: Number(r[iVeh]) || 0,
      centres: iCentres >= 0 ? Number(r[iCentres]) || 0 : null,
    };
  }

  const signals = [];
  if (existsSync(SNAPSHOT)) {
    const prev = JSON.parse(readFileSync(SNAPSHOT, "utf8"));
    const today = new Date().toISOString().slice(0, 10);
    for (const [key, cur] of Object.entries(current)) {
      const old = prev.data?.[key];
      if (!old) continue; // new licences are noisy; focus on growth of existing operators
      const minJump = config.olicence?.minVehicleIncrease ?? 3;
      if (cur.vehicles - old.vehicles >= minJump) {
        signals.push({
          source: "olicence", type: "fleet_expansion",
          company_name: cur.name,
          signal_summary: `Authorised fleet increased from ${old.vehicles} to ${cur.vehicles} vehicles (O-licence register, snapshot ${prev.date} → ${today})`,
          signal_date: today,
          evidence: [{ url: "https://www.vehicle-operator-licensing.service.gov.uk/search", title: "DVSA operator licence register (search operator name)", date: today }],
        });
      }
      if (old.centres != null && cur.centres != null && cur.centres > old.centres) {
        signals.push({
          source: "olicence", type: "new_depot",
          company_name: cur.name,
          signal_summary: `Operating centres increased from ${old.centres} to ${cur.centres} (new depot) — O-licence register`,
          signal_date: today,
          evidence: [{ url: "https://www.vehicle-operator-licensing.service.gov.uk/search", title: "DVSA operator licence register (search operator name)", date: today }],
        });
      }
    }
    log("olicence", `${signals.length} change signals vs snapshot of ${prev.date}`);
  } else {
    log("olicence", "first run — snapshot saved, diffs start next week");
  }
  writeFileSync(SNAPSHOT, JSON.stringify({ date: new Date().toISOString().slice(0, 10), data: current }));
  return signals;
}
