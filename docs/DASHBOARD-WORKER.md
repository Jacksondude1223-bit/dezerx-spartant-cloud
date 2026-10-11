# Cloudflare dashboard

The operator dashboard can run as the independent `spartan-cloud-dashboard` Worker. Its static UI is built from the same `dashboard/public` sources as the node dashboard. It uses a separate D1 database named `spartan-cloud-dashboard`, bound as `DASHBOARD_DB`. The routing Worker keeps its existing database `2551e490-663e-4fb7-b7b5-0fe468eca54a`; the dashboard deployment script rejects that UUID. No routing database migrations or customer containers are changed by deploying this dashboard.

## First deployment

From an authenticated computer with Node.js 22 or newer, in the latest repository checkout:

```bash
cd dashboard-worker
npm ci
npx wrangler login
npm run deploy
npm run secrets
```

`npm run deploy` finds or creates only the separately named dashboard D1 database, binds it in this checkout, applies its migrations, verifies every required table, column type, primary key, index and migration entry, builds the existing UI and Monaco assets, and uploads the dashboard Worker. A database or schema failure stops the upload. The new Worker refuses API access until its secrets have been configured.

`npm run secrets` runs in Bash and prompts without echoing for the nodes' existing `ADMIN_API_SECRET`, shared `ORIGIN_SECRET`, and a new dashboard login password. The default username is `admin`, configured in `wrangler.toml`. It creates `DASHBOARD_DATA_KEY` only if that remote secret is absent. Its root-protected or user-protected local backup `.dashboard-data-key` is excluded from Git: keep it securely to restore encrypted D1 records. Reruns preserve the remote encryption key. Do not generate a replacement key for an existing database.

The old node dashboard's scrypt password hash cannot be copied into this Worker. The secret installer produces its Worker-compatible PBKDF2 hash. The node API secrets and tenant application keys do not change.

If desired, add an authenticator-app secret:

```bash
npx wrangler secret put DASHBOARD_TOTP_SECRET
```

Use a base32 secret, as with the previous dashboard. TOTP reuse is prevented atomically in D1 across Worker isolates. Existing per-plane `NODE_CONTROL_SECRET` and `ROUTING_CONTROL_SECRET` overrides are supported; set their matching values as Worker secrets if your nodes/router still use them.

Open the new dashboard's `workers.dev` URL reported by Wrangler. You can attach a dedicated Worker Custom Domain such as `panel.dezerx.cloud`. Keep this hostname separate from `load.dezerx.cloud`, the node origins and customer application hostnames.

## Git-connected Cloudflare Builds

Create a separate Worker project for this repository:

| Setting | Value |
| --- | --- |
| Worker name | `spartan-cloud-dashboard` |
| Root directory | `dashboard-worker` |
| Build command | Leave empty |
| Deploy command | `npm run deploy` |
| D1 binding | `DASHBOARD_DB` |
| D1 database | `spartan-cloud-dashboard` |

Dependencies are locked in `dashboard-worker/package-lock.json`. The deployment command builds the assets and runs migration verification itself. Its Cloudflare build token needs permissions to list/create/update D1 and deploy this Worker, plus read access to the private repository through the Git integration. If the build token cannot create D1, create the dashboard database once and supply its UUID as the build variable `DASHBOARD_DATABASE_ID`, or commit the binding produced by `npm run setup`. Never supply the routing database UUID.

Add `ADMIN_API_SECRET`, `ORIGIN_SECRET`, `DASHBOARD_PASSWORD_HASH`, `DASHBOARD_DATA_KEY`, and optional `DASHBOARD_TOTP_SECRET` as runtime Worker secrets, not frontend variables. The CLI secret installer can set these against the same Worker. Build variables and runtime secrets have different roles.

## Persistent deployment runner

A once-per-minute Cron Trigger advances queued jobs from D1. Jobs use atomic leases and revision checks, persist across Worker redeploys, and retry transient node errors. The runner checks both nodes' free memory and disk, provisions the US primary, waits for readiness, provisions Germany, then publishes routing. It renews custom-domain verification permits when needed. Automatic first-administrator creation stays off by default; optional credentials are encrypted while a deployment is active and cleared when the job finishes or fails.

One deployment action advances per cron invocation. New jobs can wait up to a minute before starting, and large first boots need several checks. Running deployments have a 30-minute deadline. Queued jobs waiting for capacity have a seven-day deadline. Permanent validation failures are shown in the deployment record for an operator to fix and retry.

Suspend, resume and terminate also use persistent jobs. Suspension publishes the router state before stopping nodes. Resume starts the database owner first and waits for both ready responses before publishing ready routing. Termination detaches a custom domain, publishes terminated routing, then terminates both copies. These operations return HTTP 202 while queued; the dashboard shows and polls their progress.

The browser talks only to the dashboard. The Worker signs HTTPS requests to the same node `/admin/*` and `/control/*` APIs and routing API. It rejects redirects so API secrets are never forwarded to another origin. Exempt machine node API paths from interactive Cloudflare challenges and Browser Integrity Check. File uploads, downloads, resource controls, console commands, logs and SQL exports remain node operations. Downloads are streamed, not stored in D1. Commands that exceed the node tunnel's response time may continue on the node; inspect node logs before repeating a state-changing action.

Login sessions, rate limits, TOTP replay state and audit records live in this dashboard D1 database. Session tokens are stored as hashes. Session cookies are Secure, HttpOnly and SameSite=Strict; writes also require a CSRF token. Instance application keys, licences and job credentials are protected with AES-GCM using a separate Worker secret. Activity logs are limited to 5,000 entries; completed jobs are retained for 30 days with credentials erased. Cloudflare Worker and D1 plan limits still apply; test your intended polling and administration load before production cutover.

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
