#!/usr/bin/env node
// Lead Scout Becca Edition - single-run entry point.
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
import {
  buildTierScope,
  classifyOpportunity,
  configuredTiers,
  needsMoreOpportunities,
  rankOpportunities,
  shouldCreatePitch,
} from "./opportunity.js";

const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const [key, value] = arg.replace(/^--/, "").split("=");
  return [key, value ?? true];
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
    const known = dryRun ? new Set() : await knownCompanies(config.resurfaceAfterDays);
    const rejected = [];
    const allQueries = [];
    let candidatesConsidered = 0;

    async function discoveryPass(scope, tier) {
      const structured = [
        ...(await companiesHouse.findCandidates(scope, log)),
        ...(tier.includeOlicence
          ? await olicence.findCandidates(scope, log, { persist: !dryRun })
          : []),
      ];
      const { queries, results } = await runSearches(scope, log, maxQueries);
      allQueries.push(...queries);
      const { candidates, rejected: passRejected } = await qualify(scope, results, structured, log);
      candidatesConsidered += candidates.length + passRejected.length;
      rejected.push(...passRejected);
      const fresh = [];
      for (const candidate of candidates) {
        const norm = normalizeName(candidate.company_name);
        if (known.has(norm)) {
          log("dedupe", `duplicate: ${candidate.company_name}`);
          rejected.push({ company_name: candidate.company_name, reason: "duplicate (already known)" });
          continue;
        }
        known.add(norm);
        if (tier.note) {
          candidate.uncertainty_notes = [tier.note, candidate.uncertainty_notes]
            .filter(Boolean).join(" ");
        }
        fresh.push({ ...candidate, norm });
      }
      return fresh;
    }

    const leads = [];
    const output = config.weeklyOutput || {};
    const target = output.targetOpportunities || config.maxLeadsPerRun || 3;
    const maxResults = output.maxResults || config.maxLeadsPerRun || 5;

    for (const tier of configuredTiers(config)) {
      if (!needsMoreOpportunities(leads.length, target)) break;
      log("widen", `running tier: ${tier.name} (${tier.resultClassification})`);
      const scope = buildTierScope(config, tier);
      const fresh = await discoveryPass(scope, tier);
      let tierAccepted = 0;

      for (const candidate of fresh) {
        if (leads.length >= maxResults || tierAccepted >= (tier.maxResults || maxResults)) break;
        const info = await enrich(candidate, log, scope.hardFilters.maxEmployees);
        if (info.over_max_employees || info.is_national_brand) {
          const reason = info.over_max_employees
            ? `company exceeds ${scope.hardFilters.maxEmployees} employees`
            : "company appears to be a national brand";
          log("qualify", `rejected post-enrichment: ${candidate.company_name} (${reason})`);
          rejected.push({ company_name: candidate.company_name, reason });
          continue;
        }

        const brand = await brandCheck({ ...candidate, website: info.website }, log);
        if (brand) {
          const score = Number(brand.brand_gap_score);
          const minScore = config.brandCheck?.minGapScore ?? 3;
          if (Number.isFinite(score) && score < minScore) {
            const reason = `brand gap score ${score}/5 is below the ${minScore}/5 threshold`;
            log("qualify", `rejected post-brand-check: ${candidate.company_name} (${reason})`);
            rejected.push({ company_name: candidate.company_name, reason });
            continue;
          }
          candidate.why_warm = [
            candidate.why_warm,
            `Brand gap ${score}/5: ${brand.specific_gaps?.[0] || "visible communication gap"}`,
          ].filter(Boolean).join(" ");
          candidate.brand = brand;
        } else {
          candidate.uncertainty_notes = [candidate.uncertainty_notes, "brand gap could not be verified"]
            .filter(Boolean).join("; ");
        }

        const contactFound = !!(info.contact_email || info.contact_name);
        const { confidence } = finalConfidence(candidate, contactFound);
        const classification = classifyOpportunity(
          candidate,
          contactFound,
          tier.resultClassification,
        );
        if (classification === "watchlist" && output.allowWatchlist === false) {
          rejected.push({ company_name: candidate.company_name, reason: "watchlist result disabled" });
          continue;
        }

        const missing = [
          ...Object.entries(candidate.checks || {}).filter(([, ok]) => !ok).map(([name]) => name),
          ...(!contactFound ? ["decision-maker contact"] : []),
          ...(!brand ? ["verified brand gap"] : []),
        ];
        const pitch = shouldCreatePitch(classification)
          ? await writePitch(config, { ...candidate, ...info, brand: candidate.brand }, log)
          : { subject: null, body: null };
        leads.push({
          run_id: dryRun ? null : run.id,
          company_name: candidate.company_name,
          company_name_normalized: candidate.norm,
          website: info.website,
          signal_summary: candidate.signal_summary,
          signal_date: candidate.signal_date,
          why_warm: candidate.why_warm,
          confidence: confidence === "reject" ? "low" : confidence,
          opportunity_classification: classification,
          source_tier: tier.name,
          qualification_checks: candidate.checks,
          manual_review_required: classification === "watchlist" || classification === "exploratory",
          suggested_next_check: missing.length
            ? `Verify ${missing.join(", ")}.`
            : "Review the evidence and approve the outreach angle.",
          uncertainty_notes: [
            candidate.uncertainty_notes,
            info.size_note === "unverified" ? "company size unverified" : null,
          ].filter(Boolean).join("; "),
          evidence: candidate.evidence,
          contact_name: info.contact_name,
          contact_role: info.contact_role,
          contact_email: info.contact_email,
          contact_source: info.contact_source,
          suggested_angle: candidate.suggested_angle,
          pitch_subject: pitch.subject,
          pitch_body: pitch.body,
        });
        tierAccepted++;
      }
      log("widen", `${tier.name}: ${tierAccepted} usable result(s); ${leads.length}/${target} weekly target`);
    }

    rankOpportunities(leads);
    leads.splice(maxResults);
    const queries = [...new Set(allQueries)];
    run.candidates_found = candidatesConsidered;

    if (!dryRun) {
      for (const lead of leads) await saveLead(lead);
      for (const item of rejected) {
        await saveRejection(run.id, normalizeName(item.company_name), item.reason);
      }
    }

    let emailSent = false;
    if (!dryRun) {
      const result = await sendMondayReport({
        leads,
        run,
        queries,
        trackerUrl: process.env.TRACKER_URL,
        config,
      });
      emailSent = !result.skipped;
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
    log("run", `done: ${leads.length} opportunities accepted, ${rejected.length} rejected`);
    if (dryRun) console.log("\n=== DRY RUN OUTPUT ===\n" + JSON.stringify(leads, null, 2));
  } catch (error) {
    log.error("run", error.message);
    if (!dryRun) {
      await finishRun(run.id, {
        status: "failed",
        error_message: error.message,
        log: log.dump(),
      }).catch(() => {});
      await alertAdmin(`Run failed: ${error.message}`, log.dump());
    }
    process.exitCode = 1;
  }
}

main();
