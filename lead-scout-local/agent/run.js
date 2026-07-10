#!/usr/bin/env node
// Lead Scout Becca Edition — single-run entry point.
// Usage: node agent/run.js [--dry-run] [--max-queries=N] [--trigger=cron]
import { readFileSync } from "fs";
import { checkEnv } from "../lib/env.js";
import { createLogger } from "../lib/logger.js";
import { alertAdmin } from "../lib/mailer.js";
import { startRun, finishRun, knownCompanies, saveLead, saveRejection, normalizeName } from "../lib/db.js";
import { runSearches } from "./search.js";
import * as companiesHouse from "./sources/companies-house.js";
import * as olicence from "./sources/olicence.js";
import { qualify, finalConfidence } from "./qualify.js";
import { enrich } from "./enrich.js";
import { writePitch } from "./pitch.js";
import { brandCheck } from "./brandcheck.js";
import { sendMondayReport } from "./report.js";

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, "").split("=");
  return [k, v ?? true];
}));
const dryRun = !!args["dry-run"];
const maxQueries = args["max-queries"] ? Number(args["max-queries"]) : null;
const trigger = args.trigger || "manual";

checkEnv();
const config = JSON.parse(readFileSync(new URL("../config/client.json", import.meta.url), "utf8"));

async function main() {
  const log = createLogger();
  let run = { id: "dry-run", candidates_found: 0 };
  if (!dryRun) run = await startRun(trigger);
  log("run", `started ${dryRun ? "(DRY RUN)" : run.id} trigger=${trigger}`);

  try {
    // One discovery pass = sources -> search -> qualify -> dedupe, for a given scope.
    const known = dryRun ? new Set() : await knownCompanies(config.resurfaceAfterDays);
    const rejected = [];
    let allQueries = [];
    let candidatesConsidered = 0;

    async function discoveryPass(scope, tierNote) {
      const structured = [
        ...(await companiesHouse.findCandidates(scope, log)),
        ...(await olicence.findCandidates(scope, log, { persist: !dryRun })),
      ];
      const { queries, results } = await runSearches(scope, log, maxQueries);
      allQueries.push(...queries);
      const { candidates, rejected: rej } = await qualify(scope, results, structured, log);
      candidatesConsidered += candidates.length + rej.length;
      rejected.push(...rej);
      const fresh = [];
      for (const c of candidates) {
        const norm = normalizeName(c.company_name);
        if (known.has(norm)) {
          log("dedupe", `duplicate: ${c.company_name}`);
          rejected.push({ company_name: c.company_name, reason: "duplicate (already known)" });
        } else {
          known.add(norm);
          if (tierNote) c.uncertainty_notes = [tierNote, c.uncertainty_notes].filter(Boolean).join(" ");
          fresh.push({ ...c, norm });
        }
      }
      return fresh;
    }

    // Ring 1: core ICP
    let fresh = await discoveryPass(config, null);

    // Widening fallback: if the core ICP produced nothing, try pre-approved adjacent tiers.
    // Same quality bar and hard filters — only the sector scope changes.
    if (fresh.length === 0 && Array.isArray(config.fallbackTiers)) {
      for (const tier of config.fallbackTiers) {
        log("widen", `no core leads — widening to tier: ${tier.name}`);
        const scope = {
          ...config,
          icp: tier.icp,
          coreQueries: tier.queries || config.coreQueries,
          rotatingQueries: config.rotatingQueries,
          companiesHouse: { ...config.companiesHouse, sicCodes: tier.sicCodes || config.companiesHouse?.sicCodes },
        };
        fresh = await discoveryPass(scope, `[Adjacent sector: ${tier.name}] ${tier.note || ""}`.trim());
        if (fresh.length > 0) break;
      }
    }
    const queries = allQueries;
    run.candidates_found = candidatesConsidered;

    // 4. Enrich + final confidence + pitch
    const leads = [];
    for (const c of fresh) {
      const info = await enrich(c, log);
      const brand = await brandCheck({ ...c, website: info.website }, log);
      if (brand) {
        c.why_warm += ` Brand gap ${brand.brand_gap_score}/5: ${brand.specific_gaps?.[0] || ""}`;
        c.brand = brand;
      }
      const { confidence, passed } = finalConfidence(c, !!(info.contact_email || info.contact_name));
      if (confidence === "reject") {
        log("qualify", `rejected post-enrichment: ${c.company_name} (${passed}/4)`);
        rejected.push({ company_name: c.company_name, reason: `only ${passed}/4 checks after enrichment` });
        continue;
      }
      const pitch = await writePitch(config, { ...c, ...info, brand: c.brand }, log);
      leads.push({
        run_id: dryRun ? null : run.id,
        company_name: c.company_name,
        company_name_normalized: c.norm,
        website: info.website,
        signal_summary: c.signal_summary,
        signal_date: c.signal_date,
        why_warm: c.why_warm,
        confidence,
        uncertainty_notes: [c.uncertainty_notes, info.size_note === "unverified" ? "company size unverified" : null].filter(Boolean).join("; "),
        evidence: c.evidence,
        contact_name: info.contact_name,
        contact_role: info.contact_role,
        contact_email: info.contact_email,
        contact_source: info.contact_source,
        suggested_angle: c.suggested_angle,
        pitch_subject: pitch.subject,
        pitch_body: pitch.body,
      });
    }

    // 5. Persist
    if (!dryRun) {
      for (const l of leads) await saveLead(l);
      for (const r of rejected) await saveRejection(run.id, normalizeName(r.company_name), r.reason);
    }

    // 6. Report
    let emailSent = false;
    if (!dryRun) {
      const res = await sendMondayReport({ leads, run, queries, trackerUrl: process.env.TRACKER_URL });
      emailSent = !res.skipped;
      log("report", emailSent ? "Monday email sent" : "email skipped (EMAIL_ENABLED=false)");
    }

    if (!dryRun) {
      await finishRun(run.id, {
        status: "completed",
        queries_executed: queries.length,
        candidates_found: run.candidates_found,
        leads_accepted: leads.length,
        email_sent: emailSent,
        log: log.dump(),
      });
    }
    log("run", `done: ${leads.length} leads accepted, ${rejected.length} rejected`);
    if (dryRun) console.log("\n=== DRY RUN OUTPUT ===\n" + JSON.stringify(leads, null, 2));
  } catch (err) {
    log.error("run", err.message);
    if (!dryRun) {
      await finishRun(run.id, { status: "failed", error_message: err.message, log: log.dump() }).catch(() => {});
      await alertAdmin(`Run failed: ${err.message}`, log.dump());
    }
    process.exitCode = 1;
  }
}

main();
