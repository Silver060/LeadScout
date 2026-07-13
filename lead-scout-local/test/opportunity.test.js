import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pickQueries } from "../agent/search.js";
import {
  buildTierScope,
  classifyOpportunity,
  configuredTiers,
  needsMoreOpportunities,
  rankOpportunities,
  shouldCreatePitch,
} from "../agent/opportunity.js";
import { enforceCandidateRules } from "../agent/qualify.js";
import { buildMondayReport } from "../agent/report.js";

const config = JSON.parse(readFileSync(new URL("../config/client.json", import.meta.url), "utf8"));

test("configured tiers progress from core to watchlist without inheriting core queries", () => {
  const tiers = configuredTiers(config);
  assert.deepEqual(tiers.map((tier) => tier.resultClassification), [
    "qualified", "adjacent", "exploratory", "watchlist",
  ]);
  const adjacent = buildTierScope(config, tiers[1]);
  assert.ok(!adjacent.rotatingQueries.includes("UK logistics company driver shortage recruitment campaign"));
});

test("query selection removes duplicates and handles an empty rotation", () => {
  assert.deepEqual(pickQueries({
    coreQueries: ["same query", "same query"],
    rotatingQueries: [],
    rotatingQueriesPerRun: 3,
  }), ["same query"]);
});

test("core opportunities require all four final checks to be qualified", () => {
  const candidate = { checks: { dated_signal: true, icp_match: true, service_link: true } };
  assert.equal(classifyOpportunity(candidate, true, "qualified"), "qualified");
  assert.equal(classifyOpportunity(candidate, false, "qualified"), "watchlist");
});

test("widening continues after zero or one usable core result and stops at target", () => {
  assert.equal(needsMoreOpportunities(0, 3), true);
  assert.equal(needsMoreOpportunities(1, 3), true);
  assert.equal(needsMoreOpportunities(3, 3), false);
});

test("exploratory classification permits uncertain sector fit but not a missing trigger", () => {
  const candidate = { checks: { dated_signal: true, icp_match: false, service_link: true } };
  assert.equal(classifyOpportunity(candidate, false, "exploratory"), "exploratory");
  candidate.checks.dated_signal = false;
  assert.equal(classifyOpportunity(candidate, false, "exploratory"), "watchlist");
});

test("watchlist tier can retain dated activity or a service link with incomplete checks", () => {
  const tier = configuredTiers(config).at(-1);
  const scope = buildTierScope(config, tier);
  const modelOutput = {
    candidates: [{
      company_name: "Example Engineering",
      signal_date: "2026-07-13",
      evidence: [{ url: "https://example.test/news", date: "2026-07-13" }],
      checks: { dated_signal: true, icp_match: false, service_link: false },
    }],
    rejected: [],
  };
  const result = enforceCandidateRules(scope, [], [], modelOutput);
  assert.equal(result.candidates.length, 1);
  assert.equal(scope.brandCheck.minGapScore, 1);
});

test("watchlist still rejects an item with neither dated activity nor service relevance", () => {
  const scope = buildTierScope(config, configuredTiers(config).at(-1));
  const result = enforceCandidateRules(scope, [], [], {
    candidates: [{
      company_name: "Evidence Free Ltd",
      signal_date: null,
      evidence: [],
      checks: { dated_signal: false, icp_match: true, service_link: false },
    }],
    rejected: [],
  });
  assert.equal(result.candidates.length, 0);
});

test("only qualified and adjacent opportunities receive full pitch frameworks", () => {
  assert.equal(shouldCreatePitch("qualified"), true);
  assert.equal(shouldCreatePitch("adjacent"), true);
  assert.equal(shouldCreatePitch("exploratory"), false);
  assert.equal(shouldCreatePitch("watchlist"), false);
});

test("opportunities rank by classification before confidence", () => {
  const items = [
    { opportunity_classification: "watchlist", confidence: "high" },
    { opportunity_classification: "qualified", confidence: "medium" },
    { opportunity_classification: "adjacent", confidence: "high" },
  ];
  rankOpportunities(items);
  assert.deepEqual(items.map((item) => item.opportunity_classification), [
    "qualified", "adjacent", "watchlist",
  ]);
});

test("Monday report labels available results and deduplicated categories", () => {
  const report = buildMondayReport({
    leads: [{
      company_name: "Example Ltd",
      opportunity_classification: "watchlist",
      source_tier: "Evidence-incomplete watchlist",
      signal_summary: "Hiring activity",
      why_warm: "Careers messaging gap",
      evidence: [],
      suggested_next_check: "Verify hiring dates",
    }],
    run: { candidates_found: 4 },
    queries: ["query"],
    config,
    date: new Date("2026-07-13T09:00:00Z"),
  });
  assert.match(report.subject, /1 opportunity/);
  assert.match(report.body, /Strongest opportunities this week/);
  assert.match(report.body, /WATCHLIST/);
  assert.doesNotMatch(report.body, /Pitch framework/);
});

test("genuinely empty report says every configured tier was exhausted", () => {
  const report = buildMondayReport({
    leads: [], run: { candidates_found: 20 }, queries: ["query"], config,
  });
  assert.match(report.body, /Every configured search tier was exhausted/);
});
