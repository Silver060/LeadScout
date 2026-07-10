// Local tracker — binds to 127.0.0.1 only (not reachable from your network), so no login needed.
import express from "express";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { listLeads, lastRun, updateLead } from "../lib/db.js";

const app = express();
app.use(express.json());
app.use(express.static(join(dirname(fileURLToPath(import.meta.url)), "public")));

app.get("/api/leads", (req, res) => res.json(listLeads()));
app.get("/api/last-run", (req, res) => res.json(lastRun()));
app.patch("/api/leads/:id", (req, res) => { updateLead(req.params.id, req.body); res.json({ ok: true }); });

const port = process.env.PORT || 3000;
app.listen(port, "127.0.0.1", () =>
  console.log(`Lead Scout tracker running — open http://localhost:${port}`)
);
