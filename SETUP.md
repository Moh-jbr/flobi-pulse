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

**Updates, like Discord.** Installed apps check for a new release when they start
and every 2 hours. When there is one, an **Update available** button appears at
the top. One click downloads it, checks its checksum, installs it where the app
already lives and restarts. Settings and keys stay. There's also
**Settings → Updates → Check now**.

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
  Sentry and Cloudflare. It never calls Cloud Monitoring, the Google API that's
  billed per read. The read-only guard blocks it, and a test checks that. The app
  doesn't create logs, metrics or anything else in your project.
* **What that leaves out:** database CPU, memory, disk-usage and connection-count
  graphs, and failure *percentages* in the recap (it shows counts, like "340 failed
  requests", instead). Those numbers only exist in Cloud Monitoring.
* **History:** the recap and Timeline can go back 30 days (Cloud Logging's default
  retention). The traffic charts and per-pod CPU/memory charts are counted while
  the app is open, so they start when you open it (up to the last hour).
