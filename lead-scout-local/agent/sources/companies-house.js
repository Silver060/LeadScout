// Companies House public API - free, authoritative UK company signals.
// Register for a key: https://developer.company-information.service.gov.uk
// Signals produced (all dateable, all with official evidence links):
//  - director_change : appointment/resignation in the last N days
//  - new_charge      : new charge registered in last N days, often expansion finance

const BASE = "https://api.company-information.service.gov.uk";

export class CompaniesHouseHttpError extends Error {
  constructor(status, path, retryable = false) {
    super(`Companies House ${status} on ${path}`);
    this.name = "CompaniesHouseHttpError";
    this.status = status;
    this.retryable = retryable;
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const authHeader = (apiKey) => "Basic " + Buffer.from(`${apiKey}:`).toString("base64");

function hasRelevantSic(company, sicCodes) {
  const actual = new Set((company.sic_codes || []).map(String));
  return sicCodes.some((code) => actual.has(String(code)));
}

function isActiveRelevantCompany(company, sicCodes) {
  return company?.company_number
    && company?.company_name
    && String(company.company_status || "").toLowerCase() === "active"
    && hasRelevantSic(company, sicCodes);
}

export function createCompaniesHouseClient({
  apiKey = process.env.COMPANIES_HOUSE_API_KEY,
  fetchImpl = globalThis.fetch,
  baseUrl = BASE,
  attempts = 3,
  baseMs = 1500,
} = {}) {
  if (!apiKey) return null;
  if (!fetchImpl) throw new Error("fetch is not available");

  async function request(path, params = {}) {
    let lastErr;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const url = new URL(baseUrl + path);
        for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
        const res = await fetchImpl(url, { headers: { Authorization: authHeader(apiKey) } });
        if (res.ok) return res.json();

        if (res.status === 401 || res.status === 403 || res.status === 404) {
          throw new CompaniesHouseHttpError(res.status, path, false);
        }
        const retryable = res.status === 429 || res.status >= 500;
        const err = new CompaniesHouseHttpError(res.status, path, retryable);
        err.retryAfter = Number(res.headers?.get?.("retry-after") || 0);
        throw err;
      } catch (e) {
        lastErr = e;
        const retryable = e.retryable || e.name === "TypeError";
        if (!retryable) throw e;
        if (attempt === attempts) break;
        const retryAfter = Number(e.retryAfter || 0) * 1000;
        const backoff = baseMs * 2 ** (attempt - 1);
        await wait(Math.max(retryAfter, backoff));
      }
    }
    throw new Error(`Companies House request failed after ${attempts} attempts: ${lastErr?.message || lastErr}`);
  }

  return { request };
}

export async function checkAuthentication({ apiKey = process.env.COMPANIES_HOUSE_API_KEY, fetchImpl = globalThis.fetch, baseMs = 1500 } = {}) {
  if (!apiKey) return { ok: false, skipped: true, reason: "missing key" };
  const client = createCompaniesHouseClient({ apiKey, fetchImpl, baseMs, attempts: 2 });
  try {
    await client.request("/search/companies", { q: "logistics", items_per_page: "1" });
    return { ok: true, skipped: false };
  } catch (e) {
    return { ok: false, skipped: false, reason: e.message };
  }
}

// Advanced search by SIC code (49410 = freight transport by road) + active status.
export async function findCandidates(config, log, options = {}) {
  const chCfg = config.companiesHouse || {};
  const apiKey = options.apiKey ?? process.env.COMPANIES_HOUSE_API_KEY;
  if (!apiKey) {
    log("ch", "skipped - no COMPANIES_HOUSE_API_KEY set");
    return [];
  }

  const client = createCompaniesHouseClient({
    apiKey,
    fetchImpl: options.fetchImpl || globalThis.fetch,
    attempts: chCfg.retryAttempts || 3,
    baseMs: chCfg.retryBaseMs ?? 1500,
  });
  const sicCodes = (chCfg.sicCodes || ["49410"]).map(String);
  const maxAgeDays = config.hardFilters?.maxSignalAgeDays || 60;
  const sample = chCfg.companiesPerRun || 20;
  const now = options.now || new Date();

  const found = [];
  try {
    const search = await client.request("/advanced-search/companies", {
      sic_codes: sicCodes.join(","),
      company_status: "active",
      size: String(sample * 3),
    });
    const items = (search.items || []).filter((c) => isActiveRelevantCompany(c, sicCodes));
    const week = Math.floor(now.getTime() / (7 * 86400e3));
    const start = items.length ? (week * sample) % items.length : 0;
    const slice = items.slice(start, start + sample).concat(items.slice(0, Math.max(0, start + sample - items.length)));

    for (const c of slice) {
      const signals = await inspectCompany(c, maxAgeDays, log, { client, now });
      found.push(...signals);
    }
  } catch (e) {
    log.error("ch", e.message);
  }
  log("ch", `${found.length} structured signals found`);
  return found;
}

export async function inspectCompany(c, maxAgeDays, log, { client, now = new Date() } = {}) {
  const num = c.company_number;
  const name = c.company_name;
  const link = `https://find-and-update.company-information.service.gov.uk/company/${num}`;
  const cutoff = new Date(now.getTime() - maxAgeDays * 86400e3);
  const signals = [];
  try {
    const incorporated = c.date_of_creation ? new Date(c.date_of_creation) : null;
    const ageYears = incorporated ? (now - incorporated) / (365.25 * 86400e3) : 0;

    const officers = await client.request(`/company/${num}/officers`, { items_per_page: "20" });
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
        evidence: [{ url: link + "/officers", title: `Companies House officers - ${name}`, date }],
      });
    }

    let charges = null;
    try {
      charges = await client.request(`/company/${num}/charges`);
    } catch (e) {
      if (e.status !== 404) log.error("ch", `${name}: ${e.message}`);
    }
    for (const charge of charges?.items || []) {
      if (charge.created_on && new Date(charge.created_on) > cutoff) {
        signals.push({
          source: "companies_house", type: "new_charge",
          company_name: name, company_number: num,
          signal_summary: `New charge registered on ${charge.created_on} (often expansion/asset finance)`,
          signal_date: charge.created_on,
          evidence: [{ url: link + "/charges", title: `Companies House charges - ${name}`, date: charge.created_on }],
        });
      }
    }

    if (ageYears >= 15 && signals.length) {
      signals.forEach((s) => (s.signal_summary += `; Company trading ${Math.floor(ageYears)} years (possible succession horizon)`));
    }
  } catch (e) {
    log.error("ch", `${name}: ${e.message}`);
  }
  return signals;
}
