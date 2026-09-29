# Flobi Pulse — setup

This guide takes you from this folder to an installer your team can download.
Each step says exactly what it changes. **Nothing here touches the cluster, pods,
deployments or any service configuration.** The only Google Cloud change is
one new *viewer-only* service account with a key. Review each command before
running it.

---

## 0. Try it first (no setup at all)

```bash
npm install
npm run demo
```

This opens the app with simulated data, so you can see every screen before
connecting anything.

---

## 1. Create the read-only service account and its key

Run this in Cloud Shell. It creates **one new service account** and gives it
four **Viewer** roles. It changes nothing else.

```bash
PROJECT=flobi-prod-2026
SA_NAME=flobi-pulse-viewer
SA="$SA_NAME@$PROJECT.iam.gserviceaccount.com"

gcloud iam service-accounts create "$SA_NAME" \
  --project="$PROJECT" \
  --display-name="Flobi Pulse (read-only monitor)"

for ROLE in roles/container.viewer roles/logging.viewer roles/cloudsql.viewer roles/run.viewer; do
  gcloud projects add-iam-policy-binding "$PROJECT" \
    --member="serviceAccount:$SA" --role="$ROLE" --condition=None
done

gcloud iam service-accounts keys create flobi-pulse-key.json \
  --iam-account="$SA" --project="$PROJECT"
```

What the roles allow:

| Role | Allows | Does **not** allow |
| --- | --- | --- |
| `roles/container.viewer` (Kubernetes Engine Viewer) | Read pods, deployments, events, nodes, autoscalers; read the cluster endpoint | Reading pod logs directly (see below), reading Secrets, exec/attach/port-forward, any change |
| `roles/logging.viewer` (Logs Viewer) | Read logs and live-tail them | Writing or deleting logs, changing sinks |
| `roles/cloudsql.viewer` (Cloud SQL Viewer) | Read the database instance's status and recent operations (backups, maintenance, restarts) | Connecting to the database, reading any data, any change |
| `roles/run.viewer` (Cloud Run Viewer) | Read Cloud Run service status | Deploying or changing services |

Download `flobi-pulse-key.json` from Cloud Shell (⋮ → Download). This one file
is how everyone signs in. Share it with teammates through a password manager,
**never through Slack, email or git**. In the app: **Choose the key file…**, or
drop the file on the window.

Because the key belongs to this viewer-only account, it can't change anything,
even for someone who is an Owner on the project.

> If key creation is blocked by an organization policy
> (`iam.disableServiceAccountKeyCreation`), an org admin has to allow it for
> `flobi-prod-2026` first.

**Pod logs, straight from the pods (recommended).** Kubernetes Engine Viewer can't
read pod logs, so without this the Logs page falls back to Cloud Logging for a
single service (a few seconds behind). This adds one read-only permission,
`container.pods.getLogs`, the same thing `kubectl logs` uses:

```bash
gcloud iam roles create flobiPulsePodLogs --project="$PROJECT" \
  --title="Flobi Pulse: read pod logs" \
  --description="Read-only: lets Flobi Pulse stream pod logs like kubectl logs -f" \
  --permissions=container.pods.getLogs --stage=GA

gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:$SA" \
  --role="projects/$PROJECT/roles/flobiPulsePodLogs" --condition=None
```

It takes a minute or two to apply; then pick the service again on the Logs page.

> If `gcloud` refuses that permission in a custom role, do the same inside the
> cluster instead. This only allows reading pod logs in the `flobi` namespace:
>
> ```bash
> kubectl create role flobi-pulse-pod-logs -n flobi --verb=get --resource=pods/log
> kubectl create rolebinding flobi-pulse-pod-logs -n flobi --role=flobi-pulse-pod-logs \
>   --user="$SA"
> ```

**Already created the account with the older command** (the one with
`roles/monitoring.viewer`)? Swap that role for Cloud SQL Viewer. Monitoring is
no longer used because Google bills it per read:

```bash
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:$SA" --role=roles/cloudsql.viewer --condition=None
gcloud projects remove-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:$SA" --role=roles/monitoring.viewer --condition=None
```

If the **Database** page says the Cloud SQL Admin API is turned off, it can be
turned on with `gcloud services enable sqladmin.googleapis.com --project="$PROJECT"`.
It's free, but it is a project setting, so it's your call. Everything else in the
app works without it.

**Database in another project.** If the Database page says *No Cloud SQL
instance found in flobi-prod-2026*, the instance lives in a different Google
Cloud project. First find where it is. These commands only read, they change
nothing:

```bash
# Every Cloud SQL instance in every project you can see
for P in $(gcloud projects list --format="value(projectId)"); do
  gcloud sql instances list --project="$P" --format="value(connectionName,state)" 2>/dev/null
done

# The instance the pods are set up to use (from the Cloud SQL proxy settings)
kubectl get pods -n flobi -o yaml | grep -oE "[a-z][a-z0-9-]+:[a-z]+-[a-z]+[0-9]+:[a-z][a-z0-9-]+" | sort -u
```

Paste the connection name (`project:region:instance`) in **Settings → Database**.
Then the viewer account needs the same two read-only roles **in that project**.
Only run this if you're happy to add them:

```bash
DB_PROJECT=the-project-from-above
gcloud projects add-iam-policy-binding "$DB_PROJECT" \
  --member="serviceAccount:$SA" --role=roles/cloudsql.viewer --condition=None
gcloud projects add-iam-policy-binding "$DB_PROJECT" \
  --member="serviceAccount:$SA" --role=roles/logging.viewer --condition=None
```

**Or give the database its own key.** If you'd rather not give the main account
access to the database project (or you can't), make a second read-only account
**in the database's project** and add its key in **Settings → Database →
Database key → Choose key file…** (the Database page offers the same button).
The app then finds the instance in that project by itself, so no connection name
is needed. This key is only used for Cloud SQL status and the Postgres logs of
projects other than `flobi-prod-2026`, it goes through the same read-only guard,
and signing out removes it along with the main key.

```bash
DB_PROJECT=the-database-project
DB_SA_NAME=flobi-pulse-db-viewer
DB_SA="$DB_SA_NAME@$DB_PROJECT.iam.gserviceaccount.com"

gcloud iam service-accounts create "$DB_SA_NAME" \
  --project="$DB_PROJECT" \
  --display-name="Flobi Pulse (read-only database monitor)"

for ROLE in roles/cloudsql.viewer roles/logging.viewer; do
  gcloud projects add-iam-policy-binding "$DB_PROJECT" \
    --member="serviceAccount:$DB_SA" --role="$ROLE" --condition=None
done

gcloud iam service-accounts keys create flobi-pulse-db-key.json \
  --iam-account="$DB_SA" --project="$DB_PROJECT"
```

**If the key leaks or someone leaves:** create a new key (last command above),
share it, then delete the old one. Everyone drops the new file in once.

**To revoke:**
`gcloud iam service-accounts keys list --iam-account="$SA"` then
`gcloud iam service-accounts keys delete KEY_ID --iam-account="$SA"`.

---

## 2. Connect Sentry (frontend errors)

Best option: **Sentry → Settings → Developer Settings → Custom Integrations →
Create New Integration → Internal Integration** named *Flobi Pulse*, with permissions
**Project: Read**, **Issue & Event: Read**, **Organization: Read**. Save it, then
scroll down to **Tokens** and copy the token there.

> The integration page also shows a **Client Secret**. It looks just like a token
> (64 letters and numbers) but Sentry rejects it with *401 Invalid token*. Copy the
> one under **Tokens**.

A **Personal Token** (User settings → Personal Tokens, starts with `sntryu_`) with
`org:read`, `project:read` and `event:read` works too. An *Organization Auth Token*
(starts with `sntrys_`) does not: Sentry only lets those upload source maps.

In the app: **Settings → Integrations → Sentry**. Enter the organization slug (from
`https://<slug>.sentry.io`) and the token, then **Save**. Save tests the token first
and tells you if something's wrong. If your Sentry lives in the EU region, the app
notices and switches to `de.sentry.io` by itself.
To give everyone the same token without typing it, you can put `org` and `token`
in `config/team.config.json` → `sentry` before building. The token then ships
inside the installer, so only do this if the installer stays inside the team.

---

## 3. Connect Cloudflare (edge errors + Pages deploys)

**Cloudflare → My Profile → API Tokens → Create Token → Custom token**:

* Permissions: **Zone → Zone → Read**, **Zone → Analytics → Read**,
  **Account → Cloudflare Pages → Read**
* Zone resources: *Include → Specific zone →* `flobi.ai`

In the app: **Settings → Integrations → Cloudflare**. Enter the token and your
**Account ID** (shown on the right side of any zone's overview page), then
**Test** and **Save**.

---

## 3b. Connect GitHub (the Versions page)

The **Versions** page lists every release of the team's repos with its changelog,
and notifies you when a new one ships. The list of repos comes from
`flobi-release/repos.json` (set in `config/team.config.json` → `versions.manifest`),
so a repo appears as soon as it's rolled out there.

The repos are private, so **each person** creates their own read-only token (never
put one in the team config: the repo is public):

1. GitHub → Settings → Developer settings → Personal access tokens →
   **Fine-grained tokens** → Generate new token.
2. Resource owner: **4ow4-Developers**. Repository access: **All repositories**.
3. Permissions → Repository → **Contents: Read-only**. (Metadata: Read-only is
   added automatically.) Nothing else.
4. In the app: **Settings → Integrations → GitHub**, paste it, **Save**. If the
   organization requires approval for fine-grained tokens, an owner approves it once.

The read-only guard only lets the app read `repos.json` and each repo's release list.
Checks run every 5 minutes; unchanged answers don't count against GitHub's rate limit.
Cost: $0.

---

## 3c. Costs page (optional)

The **Costs** page (Billing → Costs) adds up what the platform costs each month. Each
vendor is optional: what isn't set up says so on the page, with these steps.

**Google Cloud.** Google has no API for spend, so the app reads the billing export
Google Cloud writes into BigQuery. This adds one dataset (Google fills it) and one
read-only role on that dataset. Nothing else changes.

1. Google Cloud console → **Billing** → pick the billing account → **Billing export**
   → **BigQuery export** → **Standard usage cost** → **Edit settings**. Pick a project
   linked to that billing account and create a dataset, e.g. `billing_export`, in a
   **multi-region location (US or EU)**: then it also brings in last month. It takes a
   Billing Account Administrator (or Costs Manager) with BigQuery User on the project.
2. Give the viewer service account read access to **that dataset only**: BigQuery →
   the dataset → **Sharing → Permissions → Add principal** →
   `flobi-pulse-viewer@flobi-prod-2026.iam.gserviceaccount.com` → role **BigQuery Data
   Viewer** → Save. No project-wide role and no BigQuery Job User: the app never runs
   queries.
3. Within a few hours a table named `gcp_billing_export_v1_<billing account>` appears
   (last month fills in over up to five days). In the app: **Settings → Costs →
   Google Cloud**, paste it as `project.dataset.table` and **Save**. Until Google has
   caught up, the Costs page says how far it has got and leaves Google Cloud out of the
   totals, rather than showing part of a month as the whole.

If the page says the BigQuery API is off, it can be turned on in the service
account's project (APIs & Services → BigQuery API → Enable). That's free, but it is a
project setting, so it's your call.

Cost: **$0**. The app reads the table with BigQuery's free table preview
(`tabledata.list`, the API behind the console's *Preview* tab, which Google documents
as free and outside the quotas) and its metadata (`tables.get`), never a query or a
job, which BigQuery would bill; the read-only guard refuses those and any other table.
The first read goes through the last six months once, a day at a time, and keeps
only the sums on this computer; after that each check reads only what changed. The
export itself is a few MB a month in your dataset, inside BigQuery's free 10 GiB of
storage.

**Cloudflare.** Edit the token from step 3 (My Profile → API Tokens) and add
**Account → Billing → Read**. Plans come from the account (Account ID in Settings →
Integrations) and the zones listed there; usage-based charges (Workers, R2…) from
Cloudflare's Billable Usage API, which covers self-serve accounts.

**GitHub.** Edit the fine-grained token from step 3b and add **Organization
permissions → Administration: Read-only**. Only owners and billing managers can see
billing, so use a token from one of them. Then **Settings → Costs → GitHub**: the
organization is the one from the Versions page unless you set another, and the
**price per seat** (a month) counts the plan's seats, whose price isn't in GitHub's
API (GitHub shows the seat count to owners only). A personal account's billing needs
a token whose resource owner is that account, with Plan: Read-only.

**Google AI Studio.** Nothing to add: Google bills AI Studio's Gemini API through
Cloud Billing, so when AI Studio's project is on the billing account whose export you
set up above, its usage is in that table (as *Gemini API*) and the page shows it in
its own section, taken out of Google Cloud's total. If AI Studio is billed to another
billing account, add what it costs as an item with Google AI Studio as the vendor.

**OpenRouter.** OpenRouter → **Settings → Management keys → Create** (an ordinary API
key can't read usage), then paste it in **Settings → Costs → OpenRouter** and **Save**.
The page reads the usage per model for the last 30 days (all OpenRouter keeps) and
the credits left; it keeps each day it reads, so from the next month on last month is
complete too.

**fal.** fal → **Settings → API keys → Create key** with the **Admin** scope (fal's
usage API needs it), then paste it in **Settings → Costs → fal** and **Save**. The page
reads the usage per endpoint for the last six months and the credit balance.

Both keys can do more than read, so they're saved encrypted on your computer and the
read-only guard lets them read usage and credits and nothing else. Usage counts as
it's spent, so don't also add top-ups as items. The page shows how long the credits
last at this month's pace and turns orange a week before they run out. Under each key,
**Alert me when the credits are below** turns on an alert at the amount you choose
(the balance is then checked every 30 minutes).

**Replicate, Sentry, Clerk and everything else** (no billing API): **Settings → Costs →
Add Replicate**, **Add Sentry**, **Add Clerk** or **Add item**: vendor, what it is,
amount, currency, how often (monthly, yearly, quarterly, weekly, one-time), and the
renewal (or payment) date. For Replicate, what you spend in a month (Replicate →
Account → Billing shows it); change it when the bill does, or add each invoice as a
one-time item. A Clerk add-on, or users past what the plan includes, can be an item of
its own with Clerk as the vendor. If amounts mix currencies, type the rate there too.

The page checks every 6 hours; **Refresh** reads again at once (at most once a minute).

---

## 4. Publish a release (installers for Windows, macOS and Linux)

Releases are built by GitHub Actions from the public repo
[github.com/Moh-jbr/flobi-pulse](https://github.com/Moh-jbr/flobi-pulse). Public
repos get GitHub's standard runners for free, so this costs **$0**. Keep the repo
public and keep the workflow on the standard runners (`ubuntu-latest`,
`windows-latest`, `macos-latest`).

To ship a new version:

```bash
npm version patch        # 1.0.0 → 1.0.1 (use minor or major for bigger changes)
git push --follow-tags
```

The pushed tag runs `.github/workflows/release.yml`. It tests, builds all three
platforms in parallel (about 15 minutes) and publishes a release with:

| File | Who it's for |
| --- | --- |
| `Flobi-Pulse-Windows.zip`, `Flobi-Pulse-macOS.zip`, `Flobi-Pulse-Linux.zip` | People installing for the first time: the installer plus *READ ME FIRST.txt* |
| `Flobi-Pulse-Setup-x.y.z.exe`, `Flobi-Pulse-x.y.z-mac.zip`, `Flobi-Pulse-x.y.z.AppImage` | The app itself, when it updates |
| `SHA256SUMS.txt` | Checksums the app verifies before installing an update |

**Updates, like Discord.** Installed apps check for a new release a few seconds
after they start, then every hour, when the window comes back to the front (if
the last check was more than 10 minutes ago) and when the computer wakes up.
When there is one, an **Update available** button appears at the top. One click
downloads it, checks its checksum, installs it where the app already lives and
restarts. Settings and keys stay. There's also **Settings → Updates → Check now**.

The builds aren't signed with paid certificates (that would cost money), so the
**first** install shows a warning. Updates don't.

* **Windows SmartScreen:** *More info → Run anyway*.
* **macOS:** open the app once, click *Done*, then *System Settings → Privacy &
  Security → Open Anyway*. The app is ad-hoc signed, so it opens normally after
  that and can update itself.

To build locally instead: `npm run dist:win` (on Windows), `npm run dist:mac` (on a
Mac) or `npm run dist:linux` (on Linux); the output is in `release/`. If Windows
Defender blocks the build with an `EPERM ... rename` error, add
`--config.electronDist=node_modules/electron/dist`.

---

## 5. What your teammates do

1. Download the zip for their computer from
   [the latest release](https://github.com/Moh-jbr/flobi-pulse/releases/latest),
   unzip it and follow *READ ME FIRST.txt*:
   * **Windows:** run the setup, choose the folder, done. There's a shortcut on
     the Desktop and in the Start menu.
   * **macOS:** drag the app to Applications (see the warning note above).
   * **Linux:** run `./install.sh`, choose the folder. It adds the app to the menu
     and the Desktop.
2. Open **Flobi Pulse** and drop the `flobi-pulse-key.json` file on the window
   (or click **Choose the key file…**). They only do this once; the key is
   stored encrypted on their computer.
3. That's it. Closing the window keeps it running in the menu bar / system tray,
   so alerts keep coming. When they reopen it after being away, they get the
   **While you were away** recap. New versions arrive through the **Update
   available** button.

---

## Good to know

* **Live stream limit:** Google allows 10 live log streams per project. Each open
  Flobi Pulse uses one, and someone streaming in Logs Explorer uses one too. When
  all 10 are taken, the app says so and retries every minute. Everything else
  (pods, crashes, errors, database, recap) keeps working. Errors are checked
  every 30 seconds in the meantime.
* **Costs: $0.** Everything the app reads is free: Cloud Logging (including the
  live stream), the Kubernetes API, the Cloud SQL Admin API, Cloud Run status,
  Sentry, Cloudflare, GitHub, and for the Costs page BigQuery's table preview of the
  billing export and OpenRouter's and fal's usage and credits. It never calls Cloud Monitoring, the Google API that's billed per
  read, and never runs a BigQuery query or job, which BigQuery bills per byte. The
  read-only guard blocks both, and tests check that. The app doesn't create logs,
  metrics or anything else in your project.
* **What that leaves out:** database CPU, memory, disk-usage and connection-count
  graphs, and failure *percentages* in the recap (it shows counts, like "340 failed
  requests", instead). Those numbers only exist in Cloud Monitoring.
* **History:** the recap and Timeline can go back 30 days (Cloud Logging's default
  retention). The traffic charts and per-pod CPU/memory charts are counted while
  the app is open, so they start when you open it (up to the last hour).
