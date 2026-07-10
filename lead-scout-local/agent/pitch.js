// Produces a PITCH FRAMEWORK, not a send-ready email.
// Becca writes the actual email herself — this gives her the raw material:
// hooks, talking points, angle, and a rough skeleton she rewrites in her own words.
import { readFileSync } from "fs";
import { askJSON, MODELS } from "../lib/anthropic.js";

const voiceExamples = () => {
  try { return readFileSync(new URL("../config/voice-examples.md", import.meta.url), "utf8"); }
  catch { return "(no voice examples provided)"; }
};

export async function writePitch(config, lead, log) {
  const system = `You prepare outreach FRAMEWORKS for ${config.clientName}. The owner writes
the actual email herself — you give her starting points, never finished copy to paste blindly.
Her voice, for reference (match its register in the skeleton):
${voiceExamples()}

RULES:
- Everything must be grounded in the specific trigger event and its date. No generic filler.
- Connect the signal to exactly ONE service: ${config.services.join("; ")}.
- Talking points are things SHE can say credibly, not marketing claims.
- The skeleton is deliberately rough — short, plain, obviously a draft to rewrite.
- Never invent facts beyond the evidence given.`;

  const user = `Lead:
Company: ${lead.company_name}
Signal: ${lead.signal_summary} (${lead.signal_date || "date unknown"})
Why warm: ${lead.why_warm}
Angle: ${lead.suggested_angle}
Contact: ${lead.contact_name || "unknown"} (${lead.contact_role || "role unknown"})
Brand review of their actual website: ${lead.brand ? JSON.stringify(lead.brand) : "not available"}

Return JSON: {
  "subject_options": [str, str, str],
  "opening_hook": str (one sentence referencing the trigger event AND, if available, the hook_worthy_detail from their own website - specificity earns replies),
  "talking_points": [str, str, str] (2-4 concrete points linking their situation to the service),
  "avoid": str (one thing NOT to say or assume, based on the uncertainty),
  "skeleton": str (a rough 60-90 word draft she will rewrite in her own words)
}`;

  const fw = await askJSON(MODELS.quality, system, user, 1200);
  log("pitch", `${lead.company_name}: framework ready ("${fw.subject_options?.[0]}")`);

  // Format the framework into pitch_subject/pitch_body so no schema change is needed.
  const body = [
    `SUBJECT IDEAS:\n${(fw.subject_options || []).map((s) => `  - ${s}`).join("\n")}`,
    `OPENING HOOK:\n  ${fw.opening_hook}`,
    `TALKING POINTS:\n${(fw.talking_points || []).map((t) => `  - ${t}`).join("\n")}`,
    `AVOID:\n  ${fw.avoid}`,
    `ROUGH SKELETON (rewrite in your own words):\n${fw.skeleton}`,
  ].join("\n\n");
  return { subject: fw.subject_options?.[0] || "Outreach framework", body };
}
