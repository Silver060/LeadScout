// Simple logger: prints to stdout and accumulates lines for the run row.
export function createLogger(runId = "pre-run") {
  const lines = [];
  function log(stage, msg, meta = {}) {
    const line = `${new Date().toISOString()} [${stage}] ${msg}${Object.keys(meta).length ? " " + JSON.stringify(meta) : ""}`;
    console.log(line);
    lines.push(line);
  }
  log.error = (stage, msg, meta) => log(stage, `ERROR: ${msg}`, meta);
  log.dump = () => lines.join("\n");
  log.runId = runId;
  return log;
}
