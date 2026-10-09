# What's new in Flobi Pulse

Newest first. Settings → What's new shows this file. Write what a person notices, in plain words,
under "Unreleased" as you go: `npm version` turns it into the new version and today's date.

## Unreleased

- Services can be shown as a table: one row per service, the same figures and colours as the cards. A down service's row is red, a degraded or warning one orange, and they always stay at the top.
- The table is the default. Pick Cards or Table and the choice is kept after the app closes.
- Sort the table by any column. A third click on a column, or the × on "Sorted by", puts it back in the usual order.
- Search the table by a service's name or web address.
- A service with 5 or more errors a minute now counts as a warning: an orange row and card, and it's counted under Problems.
- A service's details show what its errors say: each message from the last hour, with the ones firing right now first.
- Live Traffic has an App column and filter: which Flobi app (Notes, Drive, Flow…) sent each request.
- Flobi Pulse starts with the computer, so alerts come from the start. Turn it off in Settings → General.
- Settings has a What's new tab with this list.
- Demo data is only offered when running Flobi Pulse from source, never in the installed app.
- Nobody stays on an old version. A new version you don't install yourself installs itself the next time Flobi Pulse starts, or a day after it was offered at the latest. You get a notification when it's ready and another ten minutes before, and the toolbar counts down.

## 1.2.2 · 2026-10-05

- Updates install for everyone on the computer, through the administrator prompt.

## 1.2.1 · 2026-10-05

- Dark mode is a soft charcoal instead of pure black.

## 1.2.0 · 2026-10-04

- A new look: dark, quiet panels where colour only means a problem.
- Settings are split into tabs.
- Service cards show CPU large, memory beside it and the last hour of both, with deploys marked on the line. A card warns when memory is about to run out.
- Healthy services say Healthy in words.
- Search looks inside everything: services, pods, errors, logs and pages.
- Every Cloudflare Pages project gets an uptime check, and checks you don't want can be hidden.
- A new app icon: an oscilloscope screen with one green trace.

## 1.1.0 · 2026-09-29

- A new Costs page: what the platform costs each month, from Google Cloud, Cloudflare, GitHub, OpenRouter, fal and more, with an alert when credits run low.
- Offline, the app says so and stays quiet. Back online it catches up on what it missed.
- The past week is loaded when the app starts, so pages are never empty.
- Silence keeps a problem quiet until it's fixed, and the siren rings for at most 10 minutes per alert.
- Alerts can be muted by service or by alert.
- Errors are grouped one per stack trace, with exact rates.

## 1.0.3 · 2026-09-27

- macOS: no more flicker when moving the mouse.

## 1.0.2 · 2026-09-27

- A failed request in Live Traffic explains what went wrong, with the service's own logs for it, Copy as cURL and Copy details.
- Every alert says what is wrong, the evidence, the impact and what to do. A new Recent issues page keeps the last 7 days.
- A new Versions page lists every release of the team's apps, with a notification when one ships.
- Every table can be exported to Excel, Markdown or CSV.
- Faster, steadier log search.

## 1.0.1 · 2026-09-27

- Nothing new to see: this version checked that updating from inside the app works.

## 1.0.0 · 2026-09-27

- The first version: services, pods, live traffic, logs, errors, crashes, the database, uptime and alerts for the Flobi platform, read-only.
