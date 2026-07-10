import { braveSearch } from "../lib/brave.js";

// Rotation: pick N rotating queries based on ISO week number so each week differs deterministically.
function weekNumber(d = new Date()) {
  const jan1 = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d - jan1) / 86400e3 + jan1.getUTCDay() + 1) / 7);
}

export function pickQueries(config, maxQueries) {
  const rot = config.rotatingQueries;
  const n = config.rotatingQueriesPerRun || 3;
  const start = weekNumber() % rot.length;
  const rotating = Array.from({ length: n }, (_, i) => rot[(start + i) % rot.length]);
  const all = [...config.coreQueries, ...rotating];
  return maxQueries ? all.slice(0, maxQueries) : all;
}

export async function runSearches(config, log, maxQueries) {
  const queries = pickQueries(config, maxQueries);
  const results = [];
  for (const q of queries) {
    try {
      const r = await braveSearch(q, { freshness: "pm" });
      log("search", `"${q}" -> ${r.length} results`);
      results.push(...r.map((x) => ({ ...x, query: q })));
    } catch (e) {
      log.error("search", `query failed: ${q}: ${e.message}`);
    }
  }
  if (results.length === 0) log("search", "warning: web search returned nothing — relying on structured signals");
  return { queries, results };
}
