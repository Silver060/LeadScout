export const CLASSIFICATION_ORDER = {
  qualified: 0,
  adjacent: 1,
  exploratory: 2,
  watchlist: 3,
};

export function configuredTiers(config) {
  if (Array.isArray(config.searchTiers) && config.searchTiers.length) {
    return config.searchTiers;
  }
  return [
    {
      name: "Core logistics",
      resultClassification: "qualified",
      includeOlicence: true,
      icp: config.icp,
      queries: config.coreQueries,
      rotatingQueries: config.rotatingQueries,
      sicCodes: config.companiesHouse?.sicCodes,
      requiredChecks: ["dated_signal", "icp_match", "service_link"],
    },
    ...(config.fallbackTiers || []).map((tier) => ({
      ...tier,
      resultClassification: tier.resultClassification || "adjacent",
      includeOlicence: false,
      requiredChecks: tier.requiredChecks || ["dated_signal", "icp_match", "service_link"],
    })),
  ];
}

export function buildTierScope(config, tier) {
  return {
    ...config,
    icp: tier.icp || config.icp,
    coreQueries: tier.queries || [],
    rotatingQueries: tier.rotatingQueries || [],
    rotatingQueriesPerRun: tier.rotatingQueriesPerRun ?? config.rotatingQueriesPerRun,
    maxLeadsPerRun: tier.maxResults || config.weeklyOutput?.maxResults || config.maxLeadsPerRun,
    hardFilters: {
      ...config.hardFilters,
      minEmployees: tier.minEmployees ?? config.hardFilters.minEmployees,
      maxEmployees: tier.maxEmployees ?? config.hardFilters.maxEmployees,
      maxSignalAgeDays: tier.maxSignalAgeDays ?? config.hardFilters.maxSignalAgeDays,
    },
    companiesHouse: {
      ...config.companiesHouse,
      sicCodes: tier.sicCodes || [],
    },
    qualification: {
      requiredChecks: tier.requiredChecks || ["dated_signal", "icp_match", "service_link"],
      requiredAnyChecks: tier.requiredAnyChecks || [],
    },
    brandCheck: {
      ...config.brandCheck,
      minGapScore: tier.minBrandGapScore ?? config.brandCheck?.minGapScore,
    },
  };
}

export function classifyOpportunity(candidate, contactFound, requestedClassification) {
  const checks = candidate.checks || {};
  const passed = ["dated_signal", "icp_match", "service_link", "contact_found"]
    .filter((name) => name === "contact_found" ? contactFound : checks[name] === true).length;

  if (requestedClassification === "qualified") {
    return passed === 4 ? "qualified" : "watchlist";
  }
  if (requestedClassification === "adjacent") {
    return checks.dated_signal && checks.icp_match && checks.service_link ? "adjacent" : "watchlist";
  }
  if (requestedClassification === "exploratory") {
    return checks.dated_signal && checks.service_link ? "exploratory" : "watchlist";
  }
  return "watchlist";
}

export function shouldCreatePitch(classification) {
  return classification === "qualified" || classification === "adjacent";
}

export function needsMoreOpportunities(acceptedCount, target) {
  return acceptedCount < target;
}

export function rankOpportunities(items) {
  return items.sort((a, b) =>
    (CLASSIFICATION_ORDER[a.opportunity_classification] ?? 99) -
      (CLASSIFICATION_ORDER[b.opportunity_classification] ?? 99) ||
    Number(b.confidence === "high") - Number(a.confidence === "high"));
}
