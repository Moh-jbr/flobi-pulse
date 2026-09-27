# Flobi Pulse

A desktop app for **macOS and Windows** that monitors the whole Flobi platform
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
| **Errors** | Backend errors from every pod, grouped (the same error = one row with a count and sparkline), with stack traces and the pods involved. **Frontend errors from Sentry** in the same list. Brand-new error types get a *New* badge and an alert. |
| **Crashes & Down** | What's down right now, every active alert (acknowledge or mute for an hour), unhealthy pods, and every container crash in the last 24 hours with the reason (e.g. *Out of memory*) and **the logs from right before the crash**. |
| **Logs** | All services in one live stream, or one service or pod straight from the Kubernetes API (like `kubectl logs -f`, no delay). Filter by level, search or regex, and search up to 30 days of history. |
| **Events** | Kubernetes events (probe failures, scheduling problems, OOM kills, scaling), explained in plain words. |
| **Infrastructure** | Nodes (CPU and memory), HPA and KEDA autoscaling, RabbitMQ and Redis containers, CronJobs, managed certificates, Cloud Run, ingress routes. |
| **Database** | Cloud SQL status, setup and recent operations (backups, maintenance, restarts, setting changes), whether the apps can connect, connection-limit hits and deadlocks, plus Postgres errors and slow statements live. |
| **Frontends** | Uptime of every app, Cloudflare edge traffic and **52x "origin unreachable" errors** (these never reach Google's logs), Cloudflare Pages deploy status, and Sentry per app. |
| **Timeline** | What happened in any time range, rebuilt from Google's history. |
| **Versions** | Every release of the team's repos (from `flobi-release/repos.json`) with its version and changelog, newest first or by product, plus a notification when a new one ships. Needs your own read-only GitHub token. |
| **While you were away** | Opens automatically when you come back (after quitting, sleeping or being away more than 10 minutes). Example: "03:02 brand restarted 3× (out of memory) · 03:04 gateway: 1,284 failed requests over 4 min · 2 new frontend errors in flobi-flow". |

**Alerts** come as native notifications (in-app banners when the window is in
front). Related alerts are grouped into one notification. The tray / menu-bar
icon turns orange or red. Closing the window keeps the app running in the tray.

**Sounds:** a warning plays a short chime. A critical alert plays a loud siren
that repeats every 20 s until someone presses **Silence** (in the red banner,
in the tray menu, or by clicking the notification), for up to 10 minutes. It
also stops by itself when the problem is fixed or the service is muted. You can
set the volume, try both sounds and turn the repeat off in Settings →
Notifications.

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
 │    └─ Uptime checks …… your public URLs                                  │
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
     * on GitHub, only this app's own latest release and its files (for updates)
     * never Cloud Monitoring, which Google bills per read, so the app costs $0

     This is covered by tests.
* **Few dependencies.** The shipped app has **no runtime npm dependencies**.
  HTTP, gRPC (for live tail), protobuf and JWT signing are built on Node's own
  modules. Build tools only: Electron, electron-builder, Vite, React, Tailwind.
* **Credentials** (service-account key, the optional database key for a database in another project, Sentry and Cloudflare tokens) are encrypted with the OS keychain through Electron `safeStorage`.
* **Shared settings** (project, cluster, uptime URLs) are in
  `config/team.config.json`, baked into every build. Each person can override them
  in Settings.

---

## Commands

| Command | What it does |
| --- | --- |
| `npm run demo` | Run with simulated data (no credentials needed) |
| `npm run dev` | Run against the real platform (sign in on first launch) |
| `npm test` | Unit tests: read-only guard, gRPC/protobuf, auth, Kubernetes watch, health model, error grouping, alerts, recap |
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
    net/guard.mjs          read-only allowlist (start here to review safety)
    net/http.mjs           HTTPS client (node:https)
    net/grpc.mjs           minimal gRPC over HTTP/2 (live log tail)
    net/protobuf.mjs       minimal protobuf codec for Cloud Logging
    auth/                  service-account JWT, scopes
    sources/               kubernetes, logging, cloudsql, sentry, cloudflare, uptime, cloudrun
    engine/
      pipeline.mjs         state + model + alerts → UI sections
      model.mjs            pods/deployments → health verdicts
      errors.mjs           error grouping
      alerts.mjs           alert rules
      recap.mjs            "While you were away"
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
