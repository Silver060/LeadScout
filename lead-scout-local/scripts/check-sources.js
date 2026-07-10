#!/usr/bin/env node
import { existsSync, statSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { inspectDirectory } from "../agent/sources/olicence.js";
import { checkAuthentication } from "../agent/sources/companies-house.js";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
try {
  process.loadEnvFile(join(projectRoot, ".env"));
} catch {
  // .env is optional here; already-set environment variables are fine.
}

const args = new Set(process.argv.slice(2));
const noNetwork = args.has("--no-network");
const snapshotPath = join(projectRoot, "data", "olicence-snapshot.json");
const snapshotBefore = existsSync(snapshotPath) ? statSync(snapshotPath).mtimeMs : null;
const config = JSON.parse(await import("fs").then(({ readFileSync }) => readFileSync(join(projectRoot, "config", "client.json"), "utf8")));
const sicCodes = (config.companiesHouse?.sicCodes || ["49410"]).map(String);

let exitCode = 0;

console.log("Companies House:");
const chKeyPresent = !!process.env.COMPANIES_HOUSE_API_KEY;
console.log(`- API key present: ${chKeyPresent ? "yes" : "no"}`);
if (noNetwork) {
  console.log("- Authentication check: skipped (--no-network)");
} else if (!chKeyPresent) {
  console.log("- Authentication check: skipped (missing key)");
} else {
  const auth = await checkAuthentication();
  console.log(`- Authentication check: ${auth.ok ? "passed" : `failed (${auth.reason})`}`);
  if (!auth.ok) exitCode = 1;
}
console.log(`- Configured SIC codes: ${sicCodes.join(", ")}`);

console.log("");
console.log("O-licence:");
const dir = process.env.OLICENCE_CSV_DIR;
const url = process.env.OLICENCE_CSV_URL;
if (dir) {
  console.log("- Mode: local directory");
  try {
    const result = inspectDirectory(dir, { strict: false });
    console.log(`- Directory: ${result.directory}`);
    console.log(`- CSV files: ${result.fileCount}`);
    console.log(`- Rows parsed: ${result.totalRows}`);
    console.log(`- Unique licences: ${Object.keys(result.current).length}`);
    console.log(`- Duplicates merged: ${result.duplicateCount}`);
    console.log(`- Rejected files: ${result.rejectedFiles.length}`);
    for (const file of result.fileSummaries) {
      console.log(`  - ${file.filename}: rows=${file.rows}; columns licence=${file.columns.licence || "n/a"}, operator=${file.columns.operator || "n/a"}, vehicles=${file.columns.vehicles || "n/a"}, centres=${file.columns.centres || "n/a"}, centreAddress=${file.columns.centreAddress || "n/a"}`);
    }
    for (const rejected of result.rejectedFiles) {
      console.log(`  - rejected ${rejected.filename}: ${rejected.error}`);
    }
    if (result.rejectedFiles.length) exitCode = 1;
  } catch (e) {
    console.log(`- Error: ${e.message}`);
    exitCode = 1;
  }
} else if (url) {
  console.log("- Mode: URL fallback");
  console.log("- Local CSV parse: skipped (OLICENCE_CSV_DIR unset)");
} else {
  console.log("- Mode: skipped");
  console.log("- Local CSV parse: skipped (no OLICENCE_CSV_DIR or OLICENCE_CSV_URL)");
}

const snapshotAfter = existsSync(snapshotPath) ? statSync(snapshotPath).mtimeMs : null;
console.log(`- Snapshot present: ${snapshotAfter == null ? "no" : "yes"}`);
console.log(`- Snapshot modified: ${snapshotBefore === snapshotAfter ? "no" : "yes"}`);
if (snapshotBefore !== snapshotAfter) exitCode = 1;

process.exitCode = exitCode;
