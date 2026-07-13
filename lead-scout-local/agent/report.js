import { env } from "../lib/env.js";
import { sendMail } from "../lib/mailer.js";

const esc = (value) => String(value || "").replace(/[&<>\"]/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;",
}[character]));

function safeUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? esc(url.toString()) : "#";
  } catch {
    return "#";
  }
}

function leadHtml(lead) {
  const classification = lead.opportunity_classification || "qualified";
  const colours = {
    qualified: "#d4edda",
    adjacent: "#dbeafe",
    exploratory: "#fef3c7",
    watchlist: "#f3f4f6",
  };
  const evidence = (lead.evidence || []).map((item) =>
    `<li><a href="${safeUrl(item.url)}">${esc(item.title)}</a>${item.date ? ` (${esc(item.date)})` : ""}</li>`
  ).join("");
  const pitch = lead.pitch_body ? `
    <div style="background:#f7f7f7;border-radius:6px;padding:12px;margin-top:8px">
      <b>Pitch framework - starting points for your email:</b>
      <p><b>Subject:</b> ${esc(lead.pitch_subject)}</p>
      <p style="white-space:pre-wrap">${esc(lead.pitch_body)}</p>
    </div>` : "";

  return `
  <div style="border:1px solid #ddd;border-radius:8px;padding:16px;margin:16px 0;font-family:sans-serif">
    <h2 style="margin:0">${esc(lead.company_name)}
      <span style="font-size:13px;padding:2px 8px;border-radius:10px;background:${colours[classification] || colours.watchlist}">${esc(classification.toUpperCase())}</span>
    </h2>
    <p><b>Source tier:</b> ${esc(lead.source_tier || "Core")}</p>
    <p><b>Trigger or activity:</b> ${esc(lead.signal_summary)} ${lead.signal_date ? `- ${esc(lead.signal_date)}` : ""}</p>
    <p><b>Why it may be relevant:</b> ${esc(lead.why_warm)}</p>
    <p><b>Uncertainty:</b> ${esc(lead.uncertainty_notes || "nothing flagged")}</p>
    <p><b>Suggested next check:</b> ${esc(lead.suggested_next_check || "Review the evidence")}</p>
    <p><b>Evidence:</b></p><ul>${evidence}</ul>
    <p><b>Suggested angle:</b> ${esc(lead.suggested_angle)}</p>
    <p><b>Contact:</b> ${esc(lead.contact_name || "not found")} ${lead.contact_role ? `(${esc(lead.contact_role)})` : ""} ${lead.contact_email ? `- ${esc(lead.contact_email)}` : "- no direct email found"}<br>
       <small>Source: ${esc(lead.contact_source)}</small> ${lead.website ? `&middot; <a href="${safeUrl(lead.website)}">${esc(lead.website)}</a>` : ""}</p>
    ${pitch}
  </div>`;
}

export function buildMondayReport({ leads, run, queries, trackerUrl, config = {}, date = new Date() }) {
  const dateLabel = date.toLocaleDateString("en-GB", {
    weekday: "short", day: "numeric", month: "short",
  });
  const greeting = esc(config.report?.greeting || "Morning Becca,");
  const prefix = config.report?.subjectPrefix || "Lead Scout";
  if (leads.length === 0) {
    return {
      subject: `${prefix} - no usable opportunities this week (${dateLabel})`,
      body: `<p style="font-family:sans-serif">${greeting}</p>
        <p style="font-family:sans-serif">Every configured search tier was exhausted, but no evidence-backed opportunity was suitable to show.</p>
        <p style="font-family:sans-serif"><b>What we searched:</b></p>
        <ul style="font-family:sans-serif">${queries.map((query) => `<li>${esc(query)}</li>`).join("")}</ul>
        <p style="font-family:sans-serif">Considered ${run.candidates_found} companies.</p>`,
    };
  }

  const counts = Object.fromEntries(["qualified", "adjacent", "exploratory", "watchlist"]
    .map((classification) => [classification, leads.filter((lead) =>
      (lead.opportunity_classification || "qualified") === classification).length]));
  return {
    subject: `${prefix} - ${leads.length} opportunit${leads.length === 1 ? "y" : "ies"} this week (${dateLabel})`,
    body: `<p style="font-family:sans-serif">${greeting}</p>
      <h1 style="font-family:sans-serif">Strongest opportunities this week</h1>
      <p style="font-family:sans-serif"><b>Qualified:</b> ${counts.qualified} &middot; <b>Adjacent:</b> ${counts.adjacent} &middot; <b>Exploratory:</b> ${counts.exploratory} &middot; <b>Watchlist:</b> ${counts.watchlist}</p>` +
      leads.map(leadHtml).join("") +
      `<p style="font-family:sans-serif;color:#666">Considered ${run.candidates_found}. ` +
      (trackerUrl ? `<a href="${safeUrl(trackerUrl)}">Track status</a>` : "") + "</p>",
  };
}

export async function sendMondayReport(input) {
  const { subject, body } = buildMondayReport(input);
  return sendMail({ to: env.reportTo(), subject, html: body });
}
