// Brand-gap check: fetches the prospect's homepage and careers page and grades the
// brand against Rebecca's diagnostic lens (brand maturity / recruitment messaging).
// This is the qualification edge for a branding business: the SIGNAL says they're
// growing or hiring; the BRAND GAP says they need her. Both together = a real lead.
import { askJSON, MODELS } from "../lib/anthropic.js";

async function fetchText(url) {
  try {
    const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(15000),
      headers: { "User-Agent": "Mozilla/5.0 (LeadScout brand review)" } });
    if (!res.ok) return null;
    const html = await res.text();
    // Strip tags/scripts to plain text, capped.
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .slice(0, 6000);
  } catch { return null; }
}

export async function brandCheck(lead, log) {
  if (!lead.website) return null;
  const base = lead.website.startsWith("http") ? lead.website : "https://" + lead.website;
  const home = await fetchText(base);
  if (!home) { log("brand", `${lead.company_name}: site unreachable`); return null; }
  let careers = null;
  for (const path of ["/careers", "/jobs", "/join-us", "/work-for-us", "/vacancies"]) {
    careers = await fetchText(base.replace(/\/$/, "") + path);
    if (careers && careers.length > 300) break;
    careers = null;
  }

  const system = `You assess the brand and recruitment communication of logistics/industrial SME websites
for a strategy-led branding consultant. Be specific and evidence-based; quote or closely paraphrase
what the site actually says. Never invent content that isn't in the text provided.`;
  const user = `Company: ${lead.company_name}
Their trigger event: ${lead.signal_summary}

HOMEPAGE TEXT:
${home}

CAREERS PAGE TEXT:
${careers || "(no careers/jobs page found at common paths)"}

Assess and return JSON: {
  "brand_gap_score": 1-5 (5 = severe gap: dated, unclear, no employer proposition; 1 = polished, clear, strong),
  "customer_clarity": str (can a new customer tell what they do and why choose them? one sentence),
  "candidate_appeal": str (would a driver/planner/manager want to work here based on this? one sentence),
  "specific_gaps": [str, str] (2-4 concrete, citable observations, e.g. "careers page is a single paragraph with no photos or employee voices"),
  "hook_worthy_detail": str (one specific thing from their site Rebecca could reference in outreach)
}`;

  try {
    const out = await askJSON(MODELS.quality, system, user, 900);
    log("brand", `${lead.company_name}: gap score ${out.brand_gap_score}/5`);
    return out;
  } catch (e) {
    log.error("brand", `${lead.company_name}: ${e.message}`);
    return null;
  }
}
