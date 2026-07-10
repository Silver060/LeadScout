import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  buildChangeSignals,
  findCandidates as findOlicenceCandidates,
  loadFromDirectory,
  loadFromUrl,
} from "../agent/sources/olicence.js";
import {
  createCompaniesHouseClient,
  findCandidates as findCompaniesHouseCandidates,
} from "../agent/sources/companies-house.js";

const snapshotPath = new URL("../data/olicence-snapshot.json", import.meta.url);
const projectRoot = fileURLToPath(new URL("..", import.meta.url));

function tempDir() {
  return mkdtempSync(join(tmpdir(), "leadscout-source-test-"));
}

function writeCsv(dir, name, rows) {
  writeFileSync(join(dir, name), rows.join("\n"));
}

function snapshotMtime() {
  return existsSync(snapshotPath) ? statSync(snapshotPath).mtimeMs : null;
}

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    async json() { return body; },
    async text() { return typeof body === "string" ? body : JSON.stringify(body); },
  };
}

function logger() {
  const messages = [];
  const log = (scope, message) => messages.push({ scope, message });
  log.error = (scope, message) => messages.push({ scope, message, error: true });
  log.messages = messages;
  return log;
}

test("O-licence rejects a missing local directory", () => {
  assert.throws(() => loadFromDirectory(join(tmpdir(), "definitely-missing-leadscout-dir")), /does not exist/);
});

test("O-licence rejects an empty local directory", () => {
  const dir = tempDir();
  try {
    assert.throws(() => loadFromDirectory(dir), /no CSV files found/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("O-licence reports unrecognised headers", () => {
  const dir = tempDir();
  try {
    writeCsv(dir, "bad.csv", ["Wrong,Headers", "1,2"]);
    assert.throws(() => loadFromDirectory(dir), /unrecognised CSV headers/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("O-licence counts distinct OCAddress rows as operating centres", () => {
  const dir = tempDir();
  try {
    writeCsv(dir, "realish.csv", [
      "LicenceNumber,OperatorName,NumberOfVehiclesAuthorised,OCAddress",
      "OB123,Acme Ltd,5,Depot One",
      "OB123,Acme Ltd,5,Depot Two",
      "OB123,Acme Ltd,5,Depot Two",
    ]);
    const loaded = loadFromDirectory(dir);
    assert.equal(loaded.current.OB123.centres, 2);
    assert.equal(loaded.duplicateCount, 2);
    assert.deepEqual(loaded.current.OB123.centreAddresses, ["Depot One", "Depot Two"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("O-licence produces no signal below vehicle threshold", () => {
  const signals = buildChangeSignals(
    { olicence: { minVehicleIncrease: 3 } },
    { OB123: { name: "Acme Ltd", vehicles: 7, centres: 1 } },
    { date: "2026-07-01", data: { OB123: { name: "Acme Ltd", vehicles: 5, centres: 1 } } },
    "2026-07-10",
  );
  assert.equal(signals.length, 0);
});

test("O-licence URL fallback loads when local directory is unset", async () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => response(200, [
    "LicenceNumber,OperatorName,NumberOfVehiclesAuthorised,OperatingCentres",
    "OB123,Acme Ltd,4,1",
  ].join("\n"));
  try {
    const loaded = await loadFromUrl("https://example.test/olicence.csv");
    assert.equal(loaded.fileCount, 1);
    assert.equal(Object.keys(loaded.current).length, 1);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("O-licence prefers local directory when both directory and URL are configured", async () => {
  const dir = tempDir();
  const oldDir = process.env.OLICENCE_CSV_DIR;
  const oldUrl = process.env.OLICENCE_CSV_URL;
  const oldFetch = globalThis.fetch;
  process.env.OLICENCE_CSV_DIR = dir;
  process.env.OLICENCE_CSV_URL = "https://example.test/should-not-be-called.csv";
  globalThis.fetch = async () => { throw new Error("URL fallback should not be called"); };
  try {
    writeCsv(dir, "local.csv", [
      "LicenceNumber,OperatorName,NumberOfVehiclesAuthorised,OperatingCentres",
      "OB123,Acme Ltd,4,1",
    ]);
    const log = logger();
    const signals = await findOlicenceCandidates({ olicence: { minVehicleIncrease: 3 } }, log, { persist: false });
    assert.ok(Array.isArray(signals));
    assert.match(log.messages.map((m) => m.message).join("\n"), /OLICENCE_CSV_URL ignored/);
  } finally {
    if (oldDir == null) delete process.env.OLICENCE_CSV_DIR;
    else process.env.OLICENCE_CSV_DIR = oldDir;
    if (oldUrl == null) delete process.env.OLICENCE_CSV_URL;
    else process.env.OLICENCE_CSV_URL = oldUrl;
    globalThis.fetch = oldFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("O-licence dry run does not write a snapshot", async () => {
  const dir = tempDir();
  const oldDir = process.env.OLICENCE_CSV_DIR;
  const before = snapshotMtime();
  process.env.OLICENCE_CSV_DIR = dir;
  try {
    writeCsv(dir, "local.csv", [
      "LicenceNumber,OperatorName,NumberOfVehiclesAuthorised,OperatingCentres",
      "OB123,Acme Ltd,4,1",
    ]);
    await findOlicenceCandidates({ olicence: { minVehicleIncrease: 3 } }, logger(), { persist: false });
    assert.equal(snapshotMtime(), before);
  } finally {
    if (oldDir == null) delete process.env.OLICENCE_CSV_DIR;
    else process.env.OLICENCE_CSV_DIR = oldDir;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("source diagnostic command does not write a snapshot", () => {
  const dir = tempDir();
  const before = snapshotMtime();
  try {
    writeCsv(dir, "local.csv", [
      "LicenceNumber,OperatorName,NumberOfVehiclesAuthorised,OperatingCentres",
      "OB123,Acme Ltd,4,1",
    ]);
    const output = execFileSync(process.execPath, ["scripts/check-sources.js", "--no-network"], {
      cwd: projectRoot,
      env: { ...process.env, OLICENCE_CSV_DIR: dir, OLICENCE_CSV_URL: "" },
      encoding: "utf8",
    });
    assert.match(output, /Snapshot modified: no/);
    assert.equal(snapshotMtime(), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Companies House missing key is graceful", async () => {
  const oldKey = process.env.COMPANIES_HOUSE_API_KEY;
  delete process.env.COMPANIES_HOUSE_API_KEY;
  try {
    const result = await findCompaniesHouseCandidates({ companiesHouse: {}, hardFilters: {} }, logger());
    assert.deepEqual(result, []);
  } finally {
    if (oldKey == null) delete process.env.COMPANIES_HOUSE_API_KEY;
    else process.env.COMPANIES_HOUSE_API_KEY = oldKey;
  }
});

test("Companies House retries a mocked rate limit", async () => {
  let calls = 0;
  const client = createCompaniesHouseClient({
    apiKey: "test-key",
    baseMs: 0,
    fetchImpl: async () => {
      calls++;
      if (calls === 1) return response(429, {});
      return response(200, { ok: true });
    },
  });
  const result = await client.request("/search/companies", { q: "x" });
  assert.deepEqual(result, { ok: true });
  assert.equal(calls, 2);
});

test("Companies House extracts mocked dated signals without inventing company data", async () => {
  const replies = [
    response(200, { items: [{
      company_number: "01234567",
      company_name: "Acme Logistics Ltd",
      company_status: "active",
      sic_codes: ["49410"],
      date_of_creation: "2000-01-01",
    }] }),
    response(200, { items: [{ name: "Jane Smith", officer_role: "director", appointed_on: "2026-07-01" }] }),
    response(200, { items: [{ created_on: "2026-07-02" }] }),
  ];
  const result = await findCompaniesHouseCandidates({
    companiesHouse: { sicCodes: ["49410"], companiesPerRun: 1, retryBaseMs: 0 },
    hardFilters: { maxSignalAgeDays: 60 },
  }, logger(), {
    apiKey: "test-key",
    now: new Date("2026-07-10T00:00:00Z"),
    fetchImpl: async () => replies.shift(),
  });
  assert.equal(result.length, 2);
  assert.deepEqual(result.map((s) => s.type).sort(), ["director_change", "new_charge"]);
  assert.ok(result.every((s) => s.company_name === "Acme Logistics Ltd"));
  assert.ok(result.every((s) => s.signal_date));
  assert.ok(result.every((s) => s.evidence?.[0]?.url.includes("01234567")));
});
