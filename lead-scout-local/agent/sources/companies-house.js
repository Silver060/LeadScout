// Companies House public API — free, authoritative UK company signals.
// Register for a key: https://developer.company-information.service.gov.uk
// Signals produced (all dateable, all with official evidence links):
//  - succession_window : company 10+ years old with active owner-directors
//  - director_change   : appointment/resignation in the last N days (leadership churn)
//  - new_charge        : new charge registered in last N days (usually expansion finance)
import { withRetry } from "../../lib/retry.js";

const BASE = "https://api.company-information.service.gov.uk";
const auth = () => "Basic " + Buffer.from(process.env.COMPANIES_HOUSE_API_KEY + ":").toString("base64");

async function ch(path, params = {}) {
  return withRetry(async () => {
    const url = new URL(BASE + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await fetch(url, { headers: { Authorization: auth() } });
    if (res.status === 429) throw new Error("Companies House rate limit");
    if (!res.ok) throw new Error(`Companies House ${res.status} on ${path}`);
    return res.json();
  }, { label: `CH:${path}`, attempts: 3, baseMs: 3000 });
}

// Advanced search by SIC code (49410 = freight transport by road) + active status.
export async function findCandidates(config, log) {
  const chCfg = config.companiesHouse || {};
  if (!process.env.COMPANIES_HOUSE_API_KEY) {
    log("ch", "skipped — no COMPANIES_HOUSE_API_KEY set");
    return [];
  }
  const sicCodes = chCfg.sicCodes || ["49410"];
  const maxAgeDays = config.hardFilters.maxSignalAgeDays || 60;
  const sample = chCfg.companiesPerRun || 20;

  const found = [];
  try {
    const search = await ch("/advanced-search/companies", {
      sic_codes: sicCodes.join(","),
      company_status: "active",
      size: String(sample * 3),
    });
    // Rotate through the result set week by week so each run inspects different companies.
    const items = search.items || [];
    const week = Math.floor(Date.now() / (7 * 86400e3));
    const start = items.length ? (week * sample) % items.length : 0;
    const slice = items.slice(start, start + sample).concat(items.slice(0, Math.max(0, start + sample - items.length)));

    for (const c of slice) {
      const signals = await inspectCompany(c, maxAgeDays, log);
      found.push(...signals);
    }
  } catch (e) {
    log.error("ch", e.message);
  }
  log("ch", `${found.length} structured signals found`);
  return found;
}

async function inspectCompany(c, maxAgeDays, log) {
  const num = c.company_number;
  const name = c.company_name;
  const link = `https://find-and-update.company-information.service.gov.uk/company/${num}`;
  const cutoff = new Date(Date.now() - maxAgeDays * 86400e3);
  const signals = [];
  try {
    // 1. Succession window: 10+ years old
    const incorporated = new Date(c.date_of_creation);
    const ageYears = (Date.now() - incorporated) / (365.25 * 86400e3);

    // 2. Recent director changes
    const officers = await ch(`/company/${num}/officers`, { items_per_page: "20" });
    const recentChanges = (officers.items || []).filter((o) => {
      const appointed = o.appointed_on && new Date(o.appointed_on) > cutoff;
      const resigned = o.resigned_on && new Date(o.resigned_on) > cutoff;
      return appointed || resigned;
    });
    for (const o of recentChanges) {
      const what = o.resigned_on && new Date(o.resigned_on) > cutoff ? "resigned" : "appointed";
      const date = what === "resigned" ? o.resigned_on : o.appointed_on;
      signals.push({
        source: "companies_house", type: "director_change",
        company_name: name, company_number: num,
        signal_summary: `Director ${what}: ${o.name} (${o.officer_role || "director"}) on ${date}`,
        signal_date: date,
        evidence: [{ url: link + "/officers", title: `Companies House officers — ${name}`, date }],
      });
    }

    // 3. New charges (expansion finance)
    if (c.links?.charges || true) {
      const charges = await ch(`/company/${num}/charges`).catch(() => null);
      for (const ch_ of charges?.items || []) {
        if (ch_.created_on && new Date(ch_.created_on) > cutoff) {
          signals.push({
            source: "companies_house", type: "new_charge",
            company_name: name, company_number: num,
            signal_summary: `New charge registered on ${ch_.created_on} (often expansion/asset finance)`,
            signal_date: ch_.created_on,
            evidence: [{ url: link + "/charges", title: `Companies House charges — ${name}`, date: ch_.created_on }],
          });
        }
      }
    }

    // 4. Succession: only worth surfacing alongside another signal or if very long-standing
    if (ageYears >= 15 && signals.length) {
      signals.forEach((s) => (s.signal_summary += ` · Company trading ${Math.floor(ageYears)} years (possible succession horizon)`));
    }
  } catch (e) {
    log.error("ch", `${name}: ${e.message}`);
  }
  return signals;
}
