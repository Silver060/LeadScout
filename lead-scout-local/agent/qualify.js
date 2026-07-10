import { askJSON, MODELS } from "../lib/anthropic.js";

// Qualification takes TWO inputs:
//  - structured signals (Companies House, O-licence register): already dated + evidenced,
//    the model assesses ICP fit and service relevance only.
//  - web search results: the model must extract, date, and evidence signals itself.
export async function qualify(config, searchResults, structuredSignals, log) {
  const system = `You qualify B2B leads for ${config.clientName}.
Ideal client: ${config.icp}
Services offered: ${config.services.join("; ")}
Warm signals: ${config.warmSignals.join("; ")}

HARD RULES:
- A lead needs a specific, dateable trigger event within the last ${config.hardFilters.maxSignalAgeDays} days. "This company exists" is not a signal. Undated sources: mark dated_signal=false.
- Structured signals (marked source companies_house / olicence) are ALREADY verified and dated — treat dated_signal=true for them; your job is icp_match and service_link.
- Auto-reject: companies clearly over ${config.hardFilters.maxEmployees} employees, plcs, national brands, or names containing: ${config.hardFilters.autoRejectNameContains.join(", ")}.
- Only companies based in: ${config.hardFilters.regions.join(", ")}.
- If the same company appears in both structured signals and search results, MERGE into one candidate combining all evidence — multiple independent signals make a stronger lead.
- Quality over quantity. Select at most ${config.maxLeadsPerRun}. Zero is acceptable.
- NON-FIT (reject or flag if evidence suggests): ${(config.hardFilters.nonFit || []).join("; ")}
- Never invent facts. If unsure, say so in uncertainty_notes.`;

  const user = `STRUCTURED SIGNALS (verified, official sources):
${JSON.stringify(structuredSignals.slice(0, 40))}

WEB SEARCH RESULTS:
${JSON.stringify(searchResults.slice(0, 50))}

Return JSON: {"candidates":[{
  "company_name": str,
  "signal_summary": str (one line; if multiple signals, combine them),
  "signal_date": "YYYY-MM-DD" or null,
  "why_warm": str (2-3 sentences linking the signal(s) to ONE of the client's services),
  "suggested_angle": str (one line),
  "uncertainty_notes": str,
  "evidence": [{"url": str, "title": str, "date": str|null}],
  "checks": {"dated_signal": bool, "icp_match": bool, "service_link": bool},
  "check_reasons": {"dated_signal": str, "icp_match": str, "service_link": str}
}],
"rejected":[{"company_name": str, "reason": str}]}
Include in "rejected" any company you considered but excluded, with the reason.`;

  const out = await askJSON(MODELS.quality, system, user, 4000);
  const candidates = (out.candidates || []).filter((c) => {
    const passed = Object.values(c.checks || {}).filter(Boolean).length;
    if (passed < 2) {
      out.rejected = out.rejected || [];
      out.rejected.push({ company_name: c.company_name, reason: `only ${passed}/3 pre-enrichment checks passed` });
      return false;
    }
    return true;
  });
  log("qualify", `${candidates.length} candidates, ${(out.rejected || []).length} rejected`);
  return { candidates: candidates.slice(0, config.maxLeadsPerRun), rejected: out.rejected || [] };
}

export function finalConfidence(candidate, contactFound) {
  const checks = { ...candidate.checks, contact_found: contactFound };
  const passed = Object.values(checks).filter(Boolean).length;
  if (passed === 4) return { confidence: "high", passed };
  if (passed === 3) return { confidence: "medium", passed };
  return { confidence: "reject", passed };
}
