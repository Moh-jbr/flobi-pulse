# Flobi Pulse

A desktop app for **macOS, Windows and Linux** that monitors the whole Flobi platform
live: every service, pod, request, error, crash, the database, the frontends and
the edge. It's **read-only by design**.

It replaces running `kubectl logs -f -l app=flobi-brand -n flobi` in Cloud Shell
one service at a time.

**Install:** download the zip for your computer from [the latest release](https://github.com/Moh-jbr/flobi-pulse/releases/latest) (Windows, macOS, Linux), unzip it and follow *READ ME FIRST.txt*. After that the app updates itself: an **Update available** button appears at the top when a new version is out.

→ **Setting it up for the team? Read [SETUP.md](SETUP.md).** To look around first, run `npm install && npm run demo`.

---

## What it shows

| Screen | What you get |
| --- | --- |
| **Overview** | Health of all workloads (healthy / degraded / down / rolling out), pods per service, CPU and memory against limits, requests and errors per minute, active alerts, endpoint uptime, recent crashes. |
| **Live Traffic** | Every request hitting the Google load balancer (`api.flobi.ai`, `ws`, `agents`, `yjs`) as it happens: method, path, status, latency, size, client, which service answered. Also requests-per-second by status class and p50/p95/p99. Filter, search, pause. |
| **Errors** | Backend errors from every pod, grouped (the same error = one row with a count over the last 7 days, when it was last seen, and a sparkline of the last hour), with stack traces and the pods involved. **Frontend errors from Sentry** in the same list. Brand-new error types get a *New* badge and an alert (the first 15 minutes on a new computer, or right after updating from 1.0.3, are the baseline, not new; so is anything from the past week). |
| **Crashes & Down** | What's down right now, every active alert (acknowledge or mute for an hour), unhealthy pods, and every container crash in the last 7 days with the reason (e.g. *Out of memory*) and **the logs from right before the crash**. |
| **Logs** | All services in one live stream (it starts with the 15 minutes before the app opened), or one service or pod straight from the Kubernetes API (like `kubectl logs -f`, no delay). Filter by level, search or regex, and search up to 30 days of history. |
| **Events** | Kubernetes events (probe failures, scheduling problems, OOM kills, scaling), explained in plain words. Kubernetes keeps them for about an hour; the warnings, restarts and scaling of the last 7 days come from Google's logs. |
| **Recent issues** | Every alert from the last 7 days, with what to do about it, plus the incidents of that week rebuilt from Google's logs (*From the logs*). |
| **Infrastructure** | Nodes (CPU and memory), HPA and KEDA autoscaling, RabbitMQ and Redis containers, CronJobs, managed certificates, Cloud Run, ingress routes. |
| **Database** | Cloud SQL status, setup and recent operations (backups, maintenance, restarts, setting changes), whether the apps can connect, connection-limit hits and deadlocks, plus Postgres errors and slow statements live. |
| **Frontends** | Uptime of every app, Cloudflare edge traffic and **52x "origin unreachable" errors** (these never reach Google's logs), Cloudflare Pages deploy status, and Sentry per app. |
| **Timeline** | What happened in any time range, rebuilt from Google's history. |
| **Versions** | Every release of the team's repos (from `flobi-release/repos.json`) with its version and changelog, newest first or by product, plus a notification when a new one ships. Needs your own read-only GitHub token. |
| **Costs** | What the platform costs: this month so far, projected for the month and last month, then each vendor line by line (Google Cloud per service, Cloudflare plans and usage, GitHub usage and seats, Google AI Studio's Gemini API, OpenRouter per model, fal per endpoint with the credits left, Replicate, Sentry, Clerk and anything else typed in once) with a 6-month trend, and a total. Reading it costs $0, see [Costs](#costs). |
| **While you were away** | Opens automatically when you come back (after quitting, sleeping or being away more than 10 minutes). Example: "03:02 brand restarted 3× (out of memory) · 03:04 gateway: 1,284 failed requests over 4 min · 2 new frontend errors in flobi-flow". |

**Alerts** come as native notifications (in-app banners when the window is in
front). Related alerts are grouped into one notification. The tray / menu-bar
icon turns orange or red. Closing the window keeps the app running in the tray.
When a problem clears, its alert stays open for a minute or two (*Recovering*),
so a problem that comes and goes doesn't notify again every time. Any alert can
be muted for an hour: muting an alert about a service mutes all of that service's
alerts, and any other alert is muted on its own. Mutes (and silences, below) carry
over a reconnect, waking up and a restart.

Failed requests at the load balancer (5xx, per service, over the last 2 minutes)
raise a warning at 5 or more that are also at least 5% of its requests, and a
critical alert at 10 or more and 10%. Status 0 (the client hung up before an
answer) isn't a server error, so it doesn't count.

**The past week:** every time it connects (on start, after waking up, after a
settings change), the app loads the last 7 days from Google's logs in the
background, so a new install, or one that was closed, doesn't open on empty pages:
error groups and their counts, container crashes (from Kubernetes events: crash
loops, failed liveness probes, out-of-memory kills), Kubernetes events, past
incidents for Recent issues, and the last 15 minutes of logs. Nothing from the
past week notifies, chimes or opens an alert, and an error type found in it never
alerts as new later. Reading logs is free, but every teammate's app shares the
project's 60 reads a minute, so it's small and slow on purpose: 23 reads for the
whole week (a day at a time, the last 24 hours first, each read capped), one
every few seconds, behind any search someone is waiting on. A day with more
errors than one read takes says so (*Busy day: showing its most recent 1,000
errors*). A restart reuses what was already read and only reads the gap.

**Sounds:** a warning plays a short chime. A critical alert plays a loud siren
that repeats every 20 s until someone presses **Silence** (in the red banner,
in the tray menu, or by clicking the notification). Each critical alert rings
for up to 10 minutes. It also stops by itself when the problem is fixed or that
alert is muted; while the problem is *Recovering* it stays quiet, and picks up
again if the problem comes back. You can set the volume, try both sounds and turn the repeat off
in Settings → Notifications.

**Silence** keeps what it rang for quiet until the problem has been fixed for
30 minutes: that alert, the same problem when it comes back (a crash loop, a
flapping service), and the service's other alerts that aren't worse (the service
going down after its pod crash-looped) show in the app with a *Silenced* tag, but
never notify, chime or ring. That holds across a reconnect, waking up and a
restart. A service counts as degraded for 15 minutes after a restart, so a crash
loop can notify again about 45 minutes after its last crash. Something worse than what
was silenced (a critical alert after a silenced warning) is news again. For 5
minutes after Silence nothing new rings or chimes either; a critical alert that
comes up meanwhile rings after that, if it's still a problem. The check button on
an alert (*Silence until it's fixed*) silences it the same way, without the 5 minutes,
which is also how to quiet a warning that keeps coming back.

**Offline:** before anything that got no answer is called down (an uptime check,
a data source), the app makes sure it isn't this computer that lost its
connection: it tries two always-up addresses of two different companies
(`www.gstatic.com/generate_204` and `cloudflare.com/cdn-cgi/trace`). If neither
answers, the app says *You're offline* (gray, not red): every page keeps what it
last saw, no alert opens or closes, a siren already going pauses, and the Costs
and Versions pages keep their numbers. It looks again every 10 seconds, and right
away when Windows or macOS says the network changed. Back online it carries on;
after more than 30 seconds offline it reconnects everything at once and *While
you were away* covers the gap.

---

## Costs

The **Costs** page (Billing → Costs) adds up what the platform costs: this month
so far, projected for the month (usage at this month's pace, plus the plans) and
last month, each vendor line by line with a 6-month trend, and a total at the end.
Yearly items count as a twelfth each month, quarterly ones as a third, weekly ones
as 52 weeks over 12 months, and one-time items only in their month. Numbers are
only what a vendor reported or what you typed in: what isn't known shows as "—",
never a guess (a plan the app started tracking this month has no amount for last
month, and the page says so). Amounts in another currency count at a rate you type
in Settings → Costs; the app doesn't look rates up.

| Vendor | Where it comes from | Needs |
| --- | --- | --- |
| **Google Cloud** | The Cloud Billing export in BigQuery (`gcp_billing_export_v1_…`), per service and invoice month, net of credits, with tax and adjustments as their own lines | Standard usage cost export turned on, and **BigQuery Data Viewer** for the app's service account on that dataset only ([SETUP.md, step 3c](SETUP.md#3c-costs-page-optional)) |
| **Cloudflare** | Subscriptions of the account and the zones in Settings (plans), and the Billable Usage API (Workers, R2, D1…) | **Account → Billing → Read** on the Cloudflare token |
| **GitHub** | The billing usage summary per month (Actions, Packages, Copilot…, after free allowances) and the plan's seats, priced with the seat price you type in | **Administration: Read-only** (organization permissions) on the GitHub token, from an owner or billing manager |
| **Google AI Studio** | The **Gemini API** lines of the same Cloud Billing export (Google bills AI Studio through Cloud Billing), taken out of Google Cloud's total so they count once | The Google Cloud export above, with AI Studio's project on that billing account (otherwise type it in) |
| **OpenRouter** | The Activity API (usage per model and day, the last 30 days: the page keeps each day it reads, so months fill in from the first read on) and the credits left; usage on your own provider keys (BYOK) is shown apart, since those providers bill it | A **management key** in Settings → Costs (an ordinary API key can't read usage) |
| **fal** | The Usage API (per endpoint and month, after discounts) and the credit balance | An **Admin key** in Settings → Costs |
| **Replicate**, **Sentry**, **Clerk** and the rest | Typed in once in Settings → Costs (none of them has a billing API): each gets its own section, anything else goes under Other | Nothing |

OpenRouter and fal are prepaid: the page shows the credits left and how long they
last at this month's pace, and turns orange when they run out within a week (or have).
In Settings → Costs each has a low-credits alert: turn it on and set an amount, and an
alert shows (like the app's other warnings: toast, notification, Recent issues) once the
balance drops below it, clearing when it's back above. While it's on, that balance is
checked every 30 minutes (free), not just every 6 hours.
Their keys can do more than read (a management key can create keys, an Admin key
can manage the account), so they're saved encrypted like the other keys, and the
read-only guard lets them reach those two reads and nothing else.

**Why it stays at $0.** Google has no API that returns spend; the documented way is
the billing export to BigQuery. Querying that table would be billed (BigQuery charges
queries per byte, and the free tier may already be used up), so the app never runs a
query or a job. It reads the table the way BigQuery's own *Preview* tab does,
through `tabledata.list`, which Google documents as free and outside the quotas,
plus `tables.get` (metadata, free), and only needs **BigQuery Data Viewer** on that
one dataset (no Job User role). The read-only guard lets nothing else through on
`bigquery.googleapis.com`, and a test checks that jobs, queries, inserts and other
tables are refused. The export itself is Google writing a few MB a month into your
dataset, well inside BigQuery's free 10 GiB of storage a month (only if other
BigQuery data already used that up would it cost anything: about $0.02 per GiB a
month, so a fraction of a cent). Cloudflare's, GitHub's, OpenRouter's and fal's
billing reads are free API calls.

**Storage meter.** Under Google Cloud, the Costs page shows how much of BigQuery's
free 10 GiB the export table uses (its size from `tables.get`) and how fast it grows.
From 80% it turns into a warning card, and an alert says so. **Keep it small** has
the one-time statement to copy and run in BigQuery's query editor:
`ALTER TABLE … SET OPTIONS (partition_expiration_days = N)`, after which BigQuery
deletes days older than N by itself, for free. N keeps the table around half the free
storage, never fewer than the 200 days the page's six months need (at most 400).
Flobi Pulse never runs it: it stays read-only. The free 10 GiB covers all the
BigQuery data in the billing account, so other data there counts too.

**How it reads.** Every 6 hours, plus **Refresh** (at most once a minute). The table
has one partition per day: the first read goes through each day of the last six
months once, newest first (so this month and last month show first), adds it up
and keeps only the sums, in `costs-bigquery.json` in the app's data folder. After
that it looks again only at the last 10 days (and at last month's days until the
10th, while late charges still land), at days whose row count changed, and at
nothing when the table hasn't changed. The first days after the export is turned on,
Google is still copying last month into it (up to five days): meanwhile every day is
counted again on each read, the page says how far the export has got, and a month
only counts once Google is past it (never a part of one as the whole). Cloudflare's and GitHub's past months are
read once; this month every time. The last results are saved, so the page shows
them right away after a restart.

---

## How it works

```
 Flobi Pulse (Electron)
 ┌─────────────────────────────── main process ─────────────────────────────┐
 │  Read-only guard ── every request is checked against an allowlist        │
 │    ├─ Kubernetes API (GKE) … list + watch, metrics-server, pod logs      │
 │    ├─ Cloud Logging ……… live tail (gRPC) + history                       │
 │    ├─ Cloud SQL Admin …… instance status + operations                    │
 │    ├─ Sentry ………………… issues          ├─ Cloudflare … edge + Pages      │
 │    ├─ Uptime checks …… your public URLs                                  │
 │    └─ Billing ……………… BigQuery export (preview only), Cloudflare, GitHub │
 │  Pipeline: health model · error grouping · alert rules · recap           │
 └──────────────────────────────────┬───────────────────────────────────────┘
                                    │ narrow IPC bridge (preload.cjs)
                       UI (React + Tailwind, sandboxed, no network)
```

* **No agent inside the cluster.** Nothing is deployed and nothing in `k8s/` changes.
* **Layers of read-only:**
  1. Everyone signs in with the same service-account key, and that account only
     has **Viewer** roles.
  2. Tokens ask for **read-only scopes** where Google has them (Logging,
     Cloud Run).
  3. `electron/core/net/guard.mjs` checks every request against an **allowlist**
     before it leaves the machine:
     * exact Kubernetes read paths, GET only
     * never Secrets, exec, attach, port-forward or proxy, and no encoded paths
     * only the app's own Cloudflare analytics queries
     * only the configured project
     * only known headers
     * on GitHub, only this app's own latest release and its files (for updates),
       and for the Versions page the release manifest file and the release lists
       of the team org's repos
     * for the Costs page, GET only: in BigQuery, the metadata and the rows of the
       ONE billing-export table set in Settings (optionally one day's partition,
       `$YYYYMMDD`), never a job, a query or another table; on Cloudflare, the plans
       of the set account and zones and the account's usage-based billing; on
       GitHub, the set organization's (or user's) billing summary per month and
       its plan; on OpenRouter, the usage (activity) and the credits; on fal, the
       usage and the credit balance (those two only once their keys are set)
     * to tell whether this computer is online, GET of exactly
       `https://www.gstatic.com/generate_204` and `https://cloudflare.com/cdn-cgi/trace`
       (nothing sent)
     * never Cloud Monitoring, which Google bills per read, and never a BigQuery
       query or job, which BigQuery bills per byte, so the app costs $0

     This is covered by tests.
* **Few dependencies.** The shipped app has **no runtime npm dependencies**.
  HTTP, gRPC (for live tail), protobuf and JWT signing are built on Node's own
  modules. Build tools only: Electron, electron-builder, Vite, React, Tailwind, and the Geist
  fonts (bundled into the build, never fetched).
* **Credentials** (service-account key, the optional database key for a database in another project, the Sentry, Cloudflare and GitHub tokens, the OpenRouter and fal keys) are encrypted with the OS keychain through Electron `safeStorage`.
* **Shared settings** (project, cluster, uptime URLs) are in
  `config/team.config.json`, baked into every build. Each person can override them
  in Settings.

---

## Commands

| Command | What it does |
| --- | --- |
| `npm run demo` | Run with simulated data (no credentials needed) |
| `npm run dev` | Run against the real platform (sign in on first launch) |
| `npm test` | Unit tests: read-only guard, gRPC/protobuf, auth, Kubernetes watch, health model, error grouping, alerts, alert sounds, recap, the past-week load, updates, saved state, costs (billing readers, totals) |
| `npm version patch && git push --follow-tags` | **Release a new version**: GitHub Actions builds Windows, macOS and Linux for free and publishes them; installed apps offer the update |
| `npm run dist:win` | Build the Windows installer locally → `release/` |
| `npm run dist:mac` | Build the macOS `.dmg` locally (on a Mac) → `release/` |
| `npm run dist:linux` | Build the Linux AppImage locally (on Linux) → `release/` |

---

## Project layout

```
electron/
  main.mjs                 window, tray, notifications, sign-in, IPC commands
  preload.cjs              the only bridge between UI and main process
  updater.mjs              Discord-style updates from this repo's GitHub releases
  assets/                  app + tray icons
  core/
    stores.mjs             settings, app state and encrypted secrets on disk
    costs.mjs              the Costs page's readers, refresh timer and BigQuery cache
    net/guard.mjs          read-only allowlist (start here to review safety)
    net/http.mjs           HTTPS client (node:https)
    net/grpc.mjs           minimal gRPC over HTTP/2 (live log tail)
    net/protobuf.mjs       minimal protobuf codec for Cloud Logging
    auth/                  service-account JWT, scopes
    sources/               kubernetes, logging, cloudsql, sentry, cloudflare, uptime, cloudrun,
                           dns (certificate domains), github (Versions page),
                           bigquery-billing, cloudflare-billing, github-billing (Costs page)
    update/release.mjs     picks and verifies the update file in a release
    update/cleanup.mjs     removes leftover update downloads
    engine/
      pipeline.mjs         state + model + alerts → UI sections
      model.mjs            pods/deployments → health verdicts
      normalize.mjs        Cloud Logging entries → requests, log lines, events
      log-parse.mjs        log levels, NestJS lines, stack traces
      backend-name.mjs     load balancer backend → Kubernetes service
      traffic.mjs          request rates, errors and latency from the live stream
      series.mjs           time buckets for charts and the recap
      errors.mjs           error grouping
      alerts.mjs           alert rules
      alert-copy.mjs       what alerts say, in plain words
      alarm.mjs            when alert sounds play (chime, siren)
      recap.mjs            "While you were away"
      backfill.mjs         the past week, loaded from Cloud Logging on start
      versions.mjs         the Versions page: releases of the team's repos
      costs.mjs            the Costs page: totals, monthly shares, projection, the 6-hour poller
      live.mjs             wires real sources into the pipeline
      demo.mjs             simulated platform (same pipeline)
src/                       React UI (views/, components/, lib/)
config/team.config.json    shared settings for your team
test/                      node --test suites
scripts/package-downloader.mjs, scripts/downloader/   the zips people download (installer + READ ME FIRST)
.github/workflows/release.yml   builds and publishes a release when a v* tag is pushed
```

### Common changes

* **Add or remove an uptime URL:** Settings → Uptime checks (just for you), or
  `config/team.config.json` → `uptime` (for everyone).
* **Change alert rules:** `electron/core/engine/alerts.mjs` → `evaluateConditions`.
* **Change what "degraded" means:** `electron/core/engine/model.mjs` → `serviceHealth`.

---

## Not visible (yet)

* **Who** made a request: the load balancer only sees IP and browser. Adding the
  Clerk user ID to a gateway log line would enable this (a code change, your call).
* **Calls between services** and one request's path across services: this needs
  OpenTelemetry → Cloud Trace in the services.
* **Queue depth inside RabbitMQ and Redis internals:** this needs a small read-only
  exporter in the cluster (not installed; it would need your approval).
* **Individual WebSocket messages:** only connections are visible.
