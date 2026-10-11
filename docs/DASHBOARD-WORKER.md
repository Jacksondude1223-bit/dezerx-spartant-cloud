# Cloudflare dashboard

The operator dashboard can run as the independent `spartan-cloud-dashboard` Worker. Its static UI is built from the same `dashboard/public` sources as the node dashboard. It uses a separate D1 database named `spartan-cloud-dashboard`, bound as `DASHBOARD_DB`. The routing Worker keeps its existing database `2551e490-663e-4fb7-b7b5-0fe468eca54a`; the dashboard deployment script rejects that UUID. No routing database migrations or customer containers are changed by deploying this dashboard.

## Setup entirely in the Cloudflare dashboard

You do not need a terminal or a local Cloudflare CLI. Cloudflare's Git-connected build runs the deployment script automatically.

1. Open **Workers & Pages → Create application** and connect the existing private GitHub repository `Jacksondude1223-bit/dezerx-spartant-cloud`.
2. Create a separate Worker project with these settings:

| Setting | Value |
| --- | --- |
| Worker name | `spartan-cloud-dashboard` |
| Root directory | `dashboard-worker` |
| Build command | Leave empty |
| Deploy command | `npm run deploy` |

3. Deploy. The build finds or creates only the separate `spartan-cloud-dashboard` D1 database, binds it as `DASHBOARD_DB`, applies and verifies its migrations, builds the dashboard assets and uploads the Worker. The routing database is rejected. The build token needs D1 edit permissions in addition to Worker deployment permissions. If it cannot create a database, create **spartan-cloud-dashboard** under **Storage & Databases → D1**, copy its UUID, and add `DASHBOARD_DATABASE_ID` under the Worker's **Build variables**, then retry the build. Use the new dashboard database UUID.
4. In the new dashboard Worker's **Settings → Variables & Secrets**, add these as type **Secret**:

| Secret | Value |
| --- | --- |
| `ADMIN_API_SECRET` | Existing admin API secret from both nodes |
| `ORIGIN_SECRET` | Existing shared origin/control secret |

5. Open the dashboard Worker's URL and go to `/setup`. It will also open setup automatically if no dashboard account exists.
6. Click **Generate setup values**. Copy each value into the corresponding runtime secret in Cloudflare:

| Secret | Value |
| --- | --- |
| `DASHBOARD_DATA_KEY` | Generated encryption key; keep a secure backup |
| `DASHBOARD_SETUP_TOKEN` | Generated token authorizing the first account setup |

7. Save and deploy the secret changes. Keep the setup page open and click **Re-check settings**, then enter a username, password and confirmation. Click **Create account**.
8. Remove `DASHBOARD_SETUP_TOKEN` from Cloudflare after setup and open the dashboard to sign in.

The password is hashed with PBKDF2 and stored in this dashboard's D1 metadata. Its plaintext is never stored. The credential record is also encrypted and authenticated with the dashboard data key. Setup requires the private token, validates the request origin and applies login rate limits; the first account is inserted atomically and further setup requests are refused. Existing accounts cannot be overwritten through this page. An existing `DASHBOARD_PASSWORD_HASH` secret is still supported for older installations, but it is unnecessary for the browser setup.

Preserve `DASHBOARD_DATA_KEY` across updates. The setup page will not generate a replacement for a configured encryption key. Secrets are entered as runtime Worker secrets, not frontend or build variables. Optional `DASHBOARD_TOTP_SECRET`, `NODE_CONTROL_SECRET` and `ROUTING_CONTROL_SECRET` can also be added through the same Cloudflare screen when needed. The admin secret must differ from the origin secret, as required by the existing node agents.

You can attach a dedicated Worker Custom Domain such as `panel.dezerx.cloud`. Keep it separate from `load.dezerx.cloud`, node origins and customer application hostnames.

## Dashboard password recovery

An operator with access to the Cloudflare account can open this dashboard's **D1 Console** and run:

```sql
DELETE FROM dashboard_metadata WHERE name = 'auth_account';
DELETE FROM dashboard_sessions;
```

If using the legacy `DASHBOARD_PASSWORD_HASH` secret, remove that runtime secret too. Add a new `DASHBOARD_SETUP_TOKEN`, then use `/setup` to create the replacement account. Preserve the encryption key, application records and other metadata. This is an administrator-only recovery operation through the Cloudflare console; the public setup endpoint never resets an existing account.

## Persistent deployment runner

A once-per-minute Cron Trigger advances queued jobs from D1. Jobs use atomic leases and revision checks, persist across Worker redeploys, and retry transient node errors. The runner checks both nodes' free memory and disk, provisions the US primary, waits for readiness, provisions Germany, then publishes routing. It renews custom-domain verification permits when needed. Automatic first-administrator creation stays off by default; optional credentials are encrypted while a deployment is active and cleared when the job finishes or fails.

One deployment action advances per cron invocation. New jobs can wait up to a minute before starting, and large first boots need several checks. Running deployments have a 30-minute deadline. Queued jobs waiting for capacity have a seven-day deadline. Permanent validation failures are shown in the deployment record for an operator to fix and retry.

Suspend, resume and terminate also use persistent jobs. Suspension publishes the router state before stopping nodes. Resume starts the database owner first and waits for both ready responses before publishing ready routing. Termination detaches a custom domain, publishes terminated routing, then terminates both copies. These operations return HTTP 202 while queued; the dashboard shows and polls their progress.

The browser talks only to the dashboard. The Worker signs HTTPS requests to the same node `/admin/*` and `/control/*` APIs and routing API. It rejects redirects so API secrets are never forwarded to another origin. Exempt machine node API paths from interactive Cloudflare challenges and Browser Integrity Check. File uploads, downloads, resource controls, console commands, logs and SQL exports remain node operations. Downloads are streamed, not stored in D1. Commands that exceed the node tunnel's response time may continue on the node; inspect node logs before repeating a state-changing action.

Login sessions, rate limits, TOTP replay state and audit records live in this dashboard D1 database. Session tokens are stored as hashes, and every session record has a secret-key signature bound to its token hash, account, expiry and CSRF token. Session cookies are Secure, HttpOnly and SameSite=Strict; writes also require a CSRF token. Instance application keys, licences and job credentials are protected with AES-GCM using a separate Worker secret. Activity logs are limited to 5,000 entries; completed jobs are retained for 30 days with credentials erased. Cloudflare Worker and D1 plan limits still apply; test your intended polling and administration load before production cutover.

## Existing node-dashboard records

The Worker discovers existing containers from the node APIs immediately. Its deployment list starts with its own records. To retain the old deployment identities and application keys, securely copy `/var/lib/spartan-dashboard/instances.json` from the dashboard host and import it after migration verification:

```bash
npm run db:verify
read -r -s -p 'Dashboard encryption key: ' DASHBOARD_DATA_KEY
printf '\n'
export DASHBOARD_DATA_KEY
node import.mjs /secure/path/instances.json
unset DASHBOARD_DATA_KEY
```

Use the exact same `DASHBOARD_DATA_KEY` as the Worker. Imports encrypt records before sending SQL, never replace an existing ID, and preserve tenant application keys and credentials. Interrupted old jobs become retryable failed records; retry them through the new dashboard. Preserve the old file securely until the deployment list and node controls have been verified. Avoid concurrent administrative changes from two dashboards.

After confirming the Worker dashboard works, stop only the old dashboard service:

```bash
sudo systemctl disable --now spartan-dashboard
```

The agents, Cloudflare tunnels, databases, backups and customer containers continue running.
