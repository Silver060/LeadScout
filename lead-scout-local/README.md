# Lead Scout — Local Edition

Runs entirely on your own Windows machine. No Replit, no Supabase, no cloud
services beyond the two APIs the agent itself needs (Anthropic + Brave) and
SMTP for sending Becca's Monday email.

Everything is stored in a single local file: `data/leadscout.db` (SQLite,
built into Node — nothing to install). Back it up by copying that file.

## Requirements

- Node.js 22 or newer (https://nodejs.org — check with `node --version`)
- An Anthropic API key, a Brave Search API key, a Companies House REST API key
  (optional but recommended), and SMTP details

The tracker and SQLite database are local. Companies House, Brave,
Anthropic/Claude, and SMTP are external services when enabled.

## Setup (once)

1. Unzip this folder somewhere permanent, e.g. `C:\LeadScout`
2. Open PowerShell in that folder and run: `npm.cmd install`
3. Copy `.env.example` to `.env` and fill in your keys and email settings
4. Edit `config/client.json` (ICP, queries) and paste 2-3 of Becca's real
   emails into `config/voice-examples.md`

For Companies House, create a free REST API key at
https://developer.company-information.service.gov.uk and put it in `.env` as
`COMPANIES_HOUSE_API_KEY=...`.

The default Claude models can be changed with `MODEL_QUALITY` and
`MODEL_TRIAGE` in `.env`.

## Running

```
node agent/run.js --dry-run              # full pipeline, nothing saved, no email
node agent/run.js --dry-run --max-queries=2   # cheap test
node agent/run.js                        # real run: saves to DB, emails Becca
npm.cmd start                            # tracker at http://localhost:3100
npm run check-sources -- --no-network    # validate local structured sources only
npm run check-sources                    # also checks Companies House auth if key is set
```

The tracker binds to localhost only — nobody else on your network can reach
it, which is why it needs no login. Becca's interface is the Monday email,
which contains the full lead cards and draft pitches.

## Scheduling Mondays (Windows Task Scheduler)

1. Open Task Scheduler → Create Basic Task → "Lead Scout Monday"
2. Trigger: Weekly, Monday, 06:30
3. Action: Start a program → browse to `run-monday.bat` in this folder
4. In the task's Settings, tick "Run task as soon as possible after a
   scheduled start is missed" (covers the PC being asleep at 06:30)
5. Output is appended to `data\run-history.log`; failures also email ALERT_TO

Note: the machine must be on (or waking) for the run to happen. That's the
trade-off of local-only. If a Monday is missed, just run `node agent/run.js`
manually — dedupe means re-running is always safe.

## Test checklist

1. `node agent/run.js --dry-run --max-queries=2` → prints leads, creates no data
2. `node agent/run.js` → run + leads appear in tracker; email arrives
3. Run twice in a row → second run rejects duplicates
4. Put a wrong BRAVE_API_KEY in .env → run fails cleanly, alert email sent. Restore.
5. `EMAIL_ENABLED=false` in .env → run works, no email
6. Double-run protection: start two runs at once → second aborts
7. Scheduled test: set the task to 5 minutes from now → fires unattended

## Migrating to the cloud later

The agent modules and pipeline are identical to the cloud edition — only
`lib/db.js` (SQLite→Postgres), `lib/env.js`, and the server auth differ.
Nothing you build or tune here is throwaway.

## Signal sources (v1.1)

Web search is now the *third* signal source, not the only one:

1. **Companies House API** (`COMPANIES_HOUSE_API_KEY` in .env — free REST API key,
   5 min to register). Emits verified, dated signals: recent director appointments/resignations
   (leadership churn → HR/leadership need) and newly registered charges (usually
   expansion/asset finance). Companies trading 15+ years get a succession-horizon tag.
   Configure SIC codes in `config/client.json` → `companiesHouse.sicCodes`
   (49410 = road freight; 52290 = other transport support; 52241 = cargo handling).

2. **DVSA O-licence register** (`OLICENCE_CSV_DIR` in .env, preferred). Reads
   offline regional operator-licence CSV files from a local folder, combines them
   into one current dataset, and diffs that against last week's snapshot
   (`data/olicence-snapshot.json`). Use:

   ```
   OLICENCE_CSV_DIR=C:/path/to/olicence-csv
   ```

   Replace the regional CSV files in that folder weekly, but keep
   `data/olicence-snapshot.json` so LeadScout can compare this week against the
   previous snapshot. Emits: authorised fleet increases (default threshold +3
   vehicles, see `olicence.minVehicleIncrease`) and new operating centres —
   i.e. fleet expansion and new depots as official data, before any press
   release. First run only saves the snapshot; diffs start the second week.
   `OLICENCE_CSV_URL` remains as a backwards-compatible fallback when
   `OLICENCE_CSV_DIR` is blank.

Run `npm run check-sources -- --no-network` after replacing the CSVs to verify
the local files without calling Companies House, Brave, Anthropic/Claude, Gemma,
or SMTP. Use `npm run check-sources` when you also want a minimal Companies
House authentication check. The diagnostic never writes leads, sends email, calls
a language model, or overwrites `data/olicence-snapshot.json`.

3. **Brave web search** — unchanged, now mainly catches contract wins, awards,
   and event appearances that registers can't see.

Signals from sources 1-2 arrive pre-dated and pre-evidenced, so the model only
judges ICP fit and service relevance. A company appearing in multiple sources
in the same week is merged into one stronger lead.

## Pitch frameworks (not drafts)

The pitch stage now produces a **framework** Becca writes from, not an email to
paste: 3 subject ideas, an opening hook tied to the trigger event, 2-4 talking
points, one "avoid" warning based on what's uncertain, and a deliberately rough
60-90 word skeleton. The email stays hers.

## Legacy widening fallback (v1.2, superseded)

If a week produces zero core-ICP leads, the agent does NOT loosen the quality
bar. Instead it re-runs the full pipeline against pre-approved adjacent sectors
defined in `config/client.json` -> `fallbackTiers` (default: warehousing/3PL,
couriers, bus & coach, plant hire, construction transport, agri contractors —
same owner-led, fleet-and-people-heavy profile). Tier leads keep every hard
filter and the dateable-trigger rule, and are clearly labelled
"[Adjacent sector: ...]" in the email and tracker so Becca knows it's a
suggestion outside core logistics. If a tier yields leads, later tiers are
skipped. Edit or empty `fallbackTiers` to control this. Becca should veto or
approve the tier list — adjacency is a judgement call, not a model guess.

## v2.0 — Retargeted for Rebecca's new branding business

The config now targets her strategy-led branding partner model (see
config/client.json; the old L&B config is archived as
config/client-lissah-boyle-legacy.json):

- **Signals** now centre on the intersection her Vol 1 manual identifies:
  workforce shortage + weak employer communication + growth outpacing brand.
  Re-advertised roles, hiring surges after wins, expansions with dated websites.
- **Brand-gap check** (agent/brandcheck.js): after enrichment, the agent fetches
  the prospect's homepage and careers page and grades the brand gap 1-5 with
  citable observations and a "hook-worthy detail" from their own site. A growth
  signal + a visible brand gap is the qualified lead; a growth signal with a
  polished brand is not.
- **Non-fit rules** from her manual (cheap-logo shoppers, output-without-strategy,
  no leadership access) are now part of qualification.
- **Fallback tier** widens to her documented expansion category: regulated
  sectors with the same workforce/trust/communication pattern (construction,
  waste, utilities contracting, food manufacturing, engineering services).
- Pitch frameworks now open with the trigger event AND a specific detail from
  the prospect's own website — per her positioning rule: lead with the
  commercial moment, never a service list.

## Progressive weekly opportunities (v2.1)

LeadScout now completes discovery, qualification, enrichment, brand checking,
and final classification for each search tier before deciding whether to widen.
It continues until `weeklyOutput.targetOpportunities` usable results have been
collected or every configured `searchTiers` entry has been exhausted.

Results are labelled honestly:

- `qualified`: core logistics fit with all final checks, including a contact;
- `adjacent`: approved workforce-heavy sector with a dated, relevant trigger;
- `exploratory`: broader founder-led SME with a verified commercial trigger and
  service link, but uncertain sector fit;
- `watchlist`: evidence suggests a useful manual review, but one or more checks
  remain incomplete.

Qualified and adjacent results receive full pitch frameworks. Exploratory and
watchlist items receive only a suggested angle and next check. Results accumulate
across tiers; weaker results never replace stronger earlier ones. Each tier owns
its queries, size range, signal-age limit, SIC codes, required checks, and result
cap. Queries are deduplicated before search and reporting.

The Monday email reports counts for all four classes and only produces a truly
empty report after every configured tier has run. This guarantees useful research
when evidence exists, not an artificial quota of supposedly qualified leads.

For a corrective one-off run, `node agent/run.js --reconsider-rejected` ignores
recent rejection history while still deduplicating previously accepted leads.
This is useful after qualification rules change; scheduled runs should omit it.
