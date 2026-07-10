import { env } from "../lib/env.js";
import { sendMail } from "../lib/mailer.js";

const esc = (s) => String(s || "").replace(/</g, "&lt;");

function leadHtml(l) {
  const ev = (l.evidence || [])
    .map((e) => `<li><a href="${esc(e.url)}">${esc(e.title)}</a>${e.date ? ` (${esc(e.date)})` : ""}</li>`)
    .join("");
  return `
  <div style="border:1px solid #ddd;border-radius:8px;padding:16px;margin:16px 0;font-family:sans-serif">
    <h2 style="margin:0">${esc(l.company_name)}
      <span style="font-size:13px;padding:2px 8px;border-radius:10px;background:${l.confidence === "high" ? "#d4edda" : "#fff3cd"}">${l.confidence.toUpperCase()}</span>
    </h2>
    <p><b>Signal:</b> ${esc(l.signal_summary)} ${l.signal_date ? `— ${esc(l.signal_date)}` : ""}</p>
    <p><b>Why this is warm:</b> ${esc(l.why_warm)}</p>
    <p><b>What we're not sure of:</b> ${esc(l.uncertainty_notes || "nothing flagged")}</p>
    <p><b>Evidence:</b></p><ul>${ev}</ul>
    <p><b>Suggested angle:</b> ${esc(l.suggested_angle)}</p>
    <p><b>Contact:</b> ${esc(l.contact_name || "not found")} ${l.contact_role ? `(${esc(l.contact_role)})` : ""} ${l.contact_email ? `— ${esc(l.contact_email)}` : "— no direct email found"}<br>
       <small>Source: ${esc(l.contact_source)}</small> ${l.website ? `· <a href="${esc(l.website)}">${esc(l.website)}</a>` : ""}</p>
    <div style="background:#f7f7f7;border-radius:6px;padding:12px;margin-top:8px">
      <b>Pitch framework — starting points for YOUR email (not copy to paste):</b>
      <p><b>Subject:</b> ${esc(l.pitch_subject)}</p>
      <p style="white-space:pre-wrap">${esc(l.pitch_body)}</p>
    </div>
  </div>`;
}

export async function sendMondayReport({ leads, run, queries, trackerUrl }) {
  const date = new Date().toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
  let subject, body;
  if (leads.length === 0) {
    subject = `Lead Scout — no leads met the bar this week (${date})`;
    body = `<p style="font-family:sans-serif">Nothing qualified this week — we'd rather send you nothing than filler.</p>
      <p style="font-family:sans-serif"><b>What we searched:</b></p>
      <ul style="font-family:sans-serif">${queries.map((q) => `<li>${esc(q)}</li>`).join("")}</ul>
      <p style="font-family:sans-serif">Considered ${run.candidates_found} companies; none had a strong, recent, dateable trigger.</p>`;
  } else {
    subject = `Lead Scout — ${leads.length} lead${leads.length > 1 ? "s" : ""} this week (${date})`;
    body = leads.map(leadHtml).join("") +
      `<p style="font-family:sans-serif;color:#666">Considered ${run.candidates_found}, rejected ${run.candidates_found - leads.length}. ` +
      (trackerUrl ? `<a href="${trackerUrl}">Track status</a>` : "") + `</p>`;
  }
  return sendMail({ to: env.reportTo(), subject, html: body });
}
