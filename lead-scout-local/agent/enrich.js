import { braveSearch } from "../lib/brave.js";
import { askJSON, MODELS } from "../lib/anthropic.js";

// Max 3 searches per lead. Never guess email addresses.
export async function enrich(candidate, log) {
  const name = candidate.company_name;
  const searches = [
    `"${name}" official website`,
    `"${name}" managing director OR founder OR owner name`,
    `"${name}" contact email`,
  ];
  const results = [];
  for (const q of searches) {
    try {
      results.push(...(await braveSearch(q, { freshness: "py", count: 5 })));
    } catch (e) {
      log.error("enrich", `${name}: ${e.message}`);
    }
  }

  const system = `Extract contact details for a UK/Ireland SME from search results.
STRICT: only report an email address that literally appears in the results. NEVER construct or guess an email pattern. If none found, contact_email must be null.`;
  const user = `Company: ${name}
Search results: ${JSON.stringify(results.slice(0, 15))}
Return JSON: {"website": str|null, "contact_name": str|null, "contact_role": str|null, "contact_email": str|null, "contact_source": str (where found, or "not found"), "size_note": str (any headcount/size evidence, or "unverified")}`;

  try {
    const info = await askJSON(MODELS.triage, system, user, 800);
    log("enrich", `${name}: contact=${info.contact_email || "none"} site=${info.website || "none"}`);
    return info;
  } catch (e) {
    log.error("enrich", `${name} extraction failed: ${e.message}`);
    return { website: null, contact_name: null, contact_role: null, contact_email: null, contact_source: "enrichment failed", size_note: "unverified" };
  }
}
