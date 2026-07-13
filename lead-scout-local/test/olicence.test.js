import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildChangeSignals, loadFromDirectory } from "../agent/sources/olicence.js";

test("offline O-licence regional CSVs merge duplicate licences and keep growth signals", () => {
  const dir = mkdtempSync(join(tmpdir(), "leadscout-olicence-"));
  try {
    writeFileSync(join(dir, "North-East.csv"), [
      "LicenceNumber,OperatorName,NumberOfVehiclesAuthorised,OperatingCentres",
      "OB1234567,Acme Haulage Ltd,7,1",
      "OB7654321,Other Transport Ltd,2,1",
    ].join("\n"));
    writeFileSync(join(dir, "north-west.CSV"), [
      "LicenceNumber,OperatorName,NumberOfVehiclesAuthorised,OperatingCentres",
      "OB1234567,Acme Haulage Limited,9,2",
    ].join("\n"));

    const loaded = loadFromDirectory(dir);
    assert.equal(loaded.fileCount, 2);
    assert.equal(loaded.totalRows, 3);
    assert.equal(Object.keys(loaded.current).length, 2);
    assert.equal(loaded.duplicateCount, 1);
    assert.equal(loaded.current.OB1234567.vehicles, 9);
    assert.equal(loaded.current.OB1234567.centres, 2);
    assert.deepEqual(loaded.current.OB1234567.sources, ["North-East.csv", "north-west.CSV"]);

    const signals = buildChangeSignals(
      { olicence: { minVehicleIncrease: 3 } },
      loaded.current,
      { date: "2026-07-01", data: { OB1234567: { name: "Acme Haulage Ltd", vehicles: 5, centres: 1 } } },
      "2026-07-10",
    );
    assert.equal(signals.length, 2);
    assert.deepEqual(signals.map((s) => s.type).sort(), ["fleet_expansion", "new_depot"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
