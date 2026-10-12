# Operator dashboard and admin API

For Cloudflare Worker hosting with its own separate D1 database, use [DASHBOARD-WORKER.md](DASHBOARD-WORKER.md). The node-hosted setup below remains available.

The dashboard (`dashboard/`) is a private control panel for the people who run the nodes. It shows both nodes and every tenant with live CPU, memory, disk and container state, and for each tenant offers a file manager, a command console, container logs and operational controls: reload caches, restart, stop and start the container, upgrade to the node image, and download the database.

It talks to the node agents through the **admin API** (`/admin/*`), signed with `ADMIN_API_SECRET`. This can be the same value as `ORIGIN_SECRET` when the deployment uses one shared API key.

## Tunnel monitoring

Each node has a **Tunnel** tab beside **Resources**. It refreshes every ten seconds while open and shows the local cloudflared tunnel ID, connector ID, account ID, readiness, active connections, edge addresses/locations, protocols, service state, version, process uptime, published ingress routes, configuration version and traffic metrics. Missing diagnostics on older cloudflared versions are reported as unavailable.

The dashboard reads `GET /api/nodes/{us|de}/tunnel`, which signs `POST /admin/tunnel` with `ADMIN_API_SECRET`. The agent reads only cloudflared's loopback diagnostics on `127.0.0.1:8789`, tunnel-token identity fields, and selected systemd service properties. No additional Cloudflare API token is required. Tunnel token secrets, CLI configuration flags and origin credentials are excluded. The endpoint cannot restart a tunnel or modify routes.

After deploying the dashboard, run `sudo spartan-node-update apply` on both nodes. New installations include the diagnostics module automatically. The optional node-hosted dashboard also needs its dashboard code updated. Agent diagnostics are cached for five seconds. Counters reset when cloudflared restarts.

Diagnostics describe the connector running on the selected node, rather than all replicas in the Cloudflare account. If the tunnel is fully disconnected, the remote dashboard cannot reach its node agent through that tunnel; inspect the node locally. While open, the tab retains the last successful sample and labels failed refreshes.

## Security model

- **Signed admin requests.** The admin API accepts `ADMIN_API_SECRET`, which must be explicitly configured on the nodes and dashboard. It may match `ORIGIN_SECRET` and `NODE_CONTROL_SECRET`; a shared key then authorizes both admin and control requests. Missing or invalid admin secrets disable `/admin/*` with 404. Secrets must be at least 32 characters, with no whitespace or placeholders. Tenant traffic and `/control/*` keep working either way.
- **The browser never holds a node secret.** The dashboard server signs every node call. The browser gets an `HttpOnly`, `SameSite=Strict` session cookie, and every change also needs a CSRF token. Sign-in is rate limited (10 attempts per IP per 15 minutes, 60 per minute overall), and passwords are stored as scrypt hashes.
- **Where it is served.** The dashboard process listens only on `127.0.0.1:8790`. When `DASHBOARD_PROXY_PORT` is set in `node.env`, the agent also serves it at `https://<node hostname>/panel/` through the node's existing tunnel route, and redirects the bare hostname (`/`) there. Only `/panel` is forwarded; `/control`, `/admin`, `/tenant` and `/__cloud_node_health` behave exactly as before. The session cookie is limited to `Path=/panel`, and node credentials are never forwarded to the dashboard.
- **Two-factor sign-in.** With `DASHBOARD_TOTP_SECRET` set, sign-in also needs a 6-digit code from an authenticator app (RFC 6238). Each code is accepted once. The installer turns this on by default when the dashboard is served publicly.
- **Kernel-enforced permissions.** File and console operations run inside the tenant container as `www-data` by default. You can choose `root` per action. Root inside a container can use the bind-mounted MariaDB socket as the database root user, which reaches every tenant database on the node, so prefer `www-data`.
- **Audit trail.** The agent logs each admin call (`admin_authorized`, with tenant, operation, run-as user and file action, but never paths or commands). The dashboard logs sign-ins and each action, including the first 200 characters of console commands, to its journal and to the Activity page.
- **Lifecycle.** With instance creation configured, the dashboard can also suspend, resume and terminate any tenant (More actions on a tenant, or the instance page). It uses one lifecycle version above the highest any party has recorded (both nodes, the routing Worker, the dashboard), in the order docs/API.md documents. If a master website also manages a tenant, change its state in one place only, so the two do not undo each other. If it did, lifecycle versions would conflict with the master website and the routing Worker would not learn the new state. "Stop" is a Docker-level stop for maintenance only.

## Persistence

Containers are recreated on upgrade. Only `/var/www/html/storage` (and the `Modules` and `Themes` folders once the restricted file manager has moved them there) is persistent. The file manager marks every folder as persistent or not. Anything changed elsewhere is lost on the next upgrade or recreation.

## Setup

1. **Update both nodes** to a release containing this change: `sudo spartan-node-update check`, then apply it as usual.
2. **Install the dashboard on one node** from a checkout of this repository:

   ```bash
   git clone https://github.com/Jacksondude1223-bit/dezerx-spartant-cloud.git
   sudo bash dezerx-spartant-cloud/scripts/install-dashboard.sh
   ```

   Press Enter at the secret prompt to generate `ADMIN_API_SECRET`. The script adds it to this node's `/etc/spartan-cloud/node.env`, restarts `spartan-agent`, and prints the value once. It then asks for a dashboard username and password, writes `/etc/spartan-cloud/dashboard.env` (mode 600), and starts `spartan-dashboard`. This node's own agent is reached over loopback, and the other node through its public origin.
3. **Set the same secret on the other node:** `sudo bash scripts/install-dashboard.sh node-secret` (it prompts with hidden input). Without a checkout there:

   ```bash
   read -r -s -p 'ADMIN_API_SECRET: ' s; echo
   sudo sed -i '/^ADMIN_API_SECRET=/d' /etc/spartan-cloud/node.env
   printf 'ADMIN_API_SECRET="%s"\n' "$s" | sudo tee -a /etc/spartan-cloud/node.env >/dev/null; unset s
   sudo systemctl restart spartan-agent
   ```
   During a fresh install it also asks:
   - **Serve the dashboard at `https://node-us.example.com/panel/`?** Answer yes to open it on the node's own hostname. Nothing changes in Cloudflare: the existing published route already sends that hostname to the agent.
   - **Require an authenticator-app code?** Answer yes. It shows a QR code (and the key for manual entry) and saves the setting only after you type a valid code.
4. **Open it** at `https://node-us.example.com/` (it redirects to `/panel/`). To have it on both hostnames, run the installer on the other node too; each dashboard has its own sign-in.
   - Optional extra lock: in Cloudflare Zero Trust, create an Access application for the path `node-us.example.com/panel` only. Do **not** protect or challenge the whole `node-us`/`node-de` hostname, because the routing Worker and master website call `/control`, `/admin` and `/tenant` on it.
   - Without publishing, use an SSH tunnel: `ssh -L 8790:127.0.0.1:8790 root@your-node`, then visit `http://localhost:8790`. If Safari loops back to the sign-in page over plain `http://localhost`, add `DASHBOARD_SECURE_COOKIE=false` to `dashboard.env` and restart the service.

The installer puts the code in `/opt/spartan-dashboard/dashboard/` (plus the three validation modules it shares with the node in `/opt/spartan-dashboard/node/`); earlier releases used `/opt/spartan-dashboard/public/`.

Other commands: `install-dashboard.sh public` serves an existing install at `/panel/`, `totp` sets up or replaces the authenticator code, and `password` changes the password. Re-running the installer updates the dashboard code while keeping `dashboard.env`. Logs: `journalctl -u spartan-dashboard -f`.

`node.env` additions: `ADMIN_API_SECRET` and, to publish the dashboard, `DASHBOARD_PROXY_PORT="8790"`. Both survive re-running the node installer.

`dashboard.env` keys: `ADMIN_API_SECRET`, `DASHBOARD_USER`, `DASHBOARD_PASSWORD_HASH` (create with `printf '%s\n' 'password' | node dashboard/server.mjs hash-password`), `US_ORIGIN`, `DE_ORIGIN` (https, or `http://127.0.0.1:8788` for the local agent), optional `DASHBOARD_BASE_PATH` (`/panel` when served by the agent), `DASHBOARD_TOTP_SECRET` (create with `node dashboard/server.mjs totp-secret`), `DASHBOARD_HOST`, `DASHBOARD_PORT`, `DASHBOARD_SESSION_HOURS` (default 12), `DASHBOARD_SECURE_COOKIE`, `DASHBOARD_LABEL`, and for instance creation `ORIGIN_SECRET`, `BASE_DOMAIN`, optional `ROUTING_API_URL`, `NODE_CONTROL_SECRET`, `ROUTING_CONTROL_SECRET`, `DASHBOARD_STATE_FILE`, `DASHBOARD_MIN_FREE_MEMORY_MB`, `DASHBOARD_MIN_FREE_DISK_GB`.

To look at the design without a node, run `node dashboard/demo/build-preview.mjs preview.html` and open the file. It uses invented data.

## Tenants, home and standby

Each tenant exists on both nodes. The **home** copy (role `primary`) runs the application, owns the database and serves every visitor; the routing Worker sends requests straight to it. The **standby** copy (role `secondary`) on the other node holds no data and serves no one; it is there for a future failover. The Tenants page shows one row per tenant (the home copy) and folds the standby underneath.

## Suspend, resume, terminate

- **Suspend:** the router answers with the suspended page first, then both nodes stop the containers. Data stays.
- **Resume:** each node restarts the tenant from its own record (home first, through `/admin/resume`), then the router marks it live. No new domain permit is needed, because the URL is unchanged.
- **Terminate:** a customer domain is detached while the tenant is still ready, the router marks it terminated, and both nodes remove the containers. The database, `storage/` and backups stay on the nodes. The tenant ID cannot be reused. The dashboard asks you to type the hostname first.

## File editor

Files open in an in-page editor (Monaco, the editor of VS Code) with syntax highlighting, search and Ctrl/Cmd+S to save. The installer downloads Monaco 0.52.2 from the npm registry, checks its pinned SHA-512 and serves it from the dashboard itself; if that fails, files open in a plain text box. Leaving the page with unsaved changes asks first, and a file changed on disk since it was opened is not overwritten without confirmation. Monaco needs `style-src 'unsafe-inline'` and `worker-src 'self' blob:` in the dashboard's Content-Security-Policy; scripts remain same-origin only.

## Creating instances

With `ORIGIN_SECRET` and `BASE_DOMAIN` in `dashboard.env`, the dashboard shows **Instances → Create instance**. Re-running `install-dashboard.sh` on a node copies both from `node.env` (and `NODE_CONTROL_SECRET` if the node uses that legacy override). Without them the page is hidden and the dashboard works as before. Set `ROUTING_API_URL` only if the routing API is not at `https://BASE_DOMAIN`, and `ROUTING_CONTROL_SECRET` only if the Worker uses that legacy override.

The form asks for the home region (`us` or `de`; it owns the database and cannot change), the domain, the Spartan licence key (the product is read from its prefix, as on the node), and an optional customer reference. The dashboard generates the tenant ID, `APP_KEY` and ownership fingerprint with the same recipe as [API.md](API.md), then follows its "Create a service" flow:

1. **Domain.** By default the routing Worker assigns `instance-NNNN.<zone>` (see "Default instance hostname" in [MANAGEMENT-API.md](MANAGEMENT-API.md)): the dashboard registers the tenant as `pending`, asks the Worker for the hostname, and Cloudflare attaches it as a Worker Custom Domain with DNS and a certificate. It is one level under the zone, so the free Universal certificate covers it (unlike `t-<id>.BASE_DOMAIN`). The licence for that hostname is entered on the deploy step, once the name is known. The hostname is the operator's, so the dashboard issues the node's provisioning permit itself. The Worker needs `CF_INSTANCE_API_TOKEN`, which `npm run configure` sets. A customer domain goes through the routing Worker's onboarding (`prepare`, then **Verify DNS** until it reports `readyToProvision`), exactly as in [MARKET_MODULE_API.md](MARKET_MODULE_API.md); the dashboard shows the DNS records to add and uses the permit the Worker issues. The licence must be issued for the chosen domain.
2. **Deploy.** Automatic administrator creation is off by default. Deploy without account details, then open the instance and complete Spartan’s first-account signup; the first account receives superadmin access. To create it during provisioning instead, enable **Create administrator automatically** and enter the name, email and password. The dashboard calls `POST /control/provision` on both nodes, including `initialAdmin` only on the primary when that option is selected, retrying while a node reports `provisioning` or is still working behind Cloudflare's 100-second limit, and finally publishes the tenant to the routing Worker as `ready` at lifecycle version 1. The page shows each step with its attempt count and elapsed time, the container's state and latest log lines from the node working on it (through the admin API), and a plain-language "What happened" log of every node answer, retry and DNS check (kept with the instance record). A failed deployment can be retried and continues where it stopped, with the same identity.

**Queue.** Pressing Deploy puts the instance in a queue. It starts when no other deployment is running on either of its nodes (a first boot is the heaviest thing a node does) and both nodes report at least `DASHBOARD_MIN_FREE_MEMORY_MB` (default 1024) free memory and `DASHBOARD_MIN_FREE_DISK_GB` (default 5) free disk through the admin API. The queue is re-checked every minute and after each deployment; the instance page shows its position and the current reason. A node at its `MAX_TENANTS` limit sends the deployment back to the queue instead of failing it. **Leave queue** returns it to ready. The queue lives in memory, along with administrator credentials only when automatic creation is selected, so restarting the dashboard clears it (those instances show `dashboard_restarted`; deploy again).

Instance records (tenant ID, keys, licence, domain, status) are kept in `/var/lib/spartan-dashboard/instances.json`, mode 600, owned by the service. The administrator password is held in memory only while deploying and is never written to disk; if the dashboard restarts mid-deployment, deploy again. A draft that has not reached either node can be discarded. After an `initial_admin_failed` error, retry with automatic creation off to finish provisioning through normal signup. An account already created by an earlier attempt is retained: sign in or use Spartan’s password reset; this option does not reset credentials or remove users.

Holding `ORIGIN_SECRET` lets the dashboard call `/control/*` and the routing API, so treat `dashboard.env` like `node.env`. Suspend, resume and terminate remain with the billing system: if a master website also manages these tenants, give each instance one owner so lifecycle versions do not conflict.

## Admin API

Every route is `POST` to a node origin. Requests are signed exactly like `/control/*` requests (`X-Spartan-Timestamp`, `X-Spartan-Signature` = HMAC-SHA256 of `timestamp\nPOST\npathname\nrawBody`), but keyed with `ADMIN_API_SECRET`. Admin calls have their own rate limit (900 per minute), so dashboard use never eats into the master website's control budget. Tenant routes take only `id`, and the agent looks up the fingerprint itself and checks the container labels.

| Route | Body | Result |
| --- | --- | --- |
| `/admin/ping` | `{}` | `{ok, region}` at once; the dashboard times it to show latency |
| `/admin/overview` | `{}` | The node's public `host`, node health (including `dockerVersion` and host network throughput: `network.rxBytesPerSecond`, `txBytesPerSecond`, `linkMbps` where the NIC reports it) plus every tenant with container state and live usage (`cpuPercent`, `memoryUsedBytes`, `memoryLimitBytes`, network and block I/O bytes, `processes`) |
| `/admin/tenants` | `{"stats": true}` optional | The tenant list, with usage when `stats` is true |
| `/admin/stats` | `{}` | `docker stats` for every running tenant container, parsed into numbers |
| `/admin/tenant` | `id` | Summary, health, resources, `versions.json`, storage bytes, start time, restart count, OOM flag |
| `/admin/logs` | `id`, `tail` (1–5000, default 300) | Timestamped stdout/stderr lines, merged in time order |
| `/admin/exec` | `id`, `command`, `cwd`, `user` (`www-data`/`root`), `timeoutSeconds` (1–90) | `exitCode`, `stdout`, `stderr`, new `cwd` (so `cd` carries over), `timedOut`, `truncated` (1 MB per stream) |
| `/admin/fs` | `id`, `action`, `path`, `user`, action fields | See below |
| `/admin/fs/download` | `id`, `path`, `user` | The file as an attachment; a folder as `.tar.gz` |
| `/admin/container` | `id`, `action` (`start`/`stop`/`restart`) | Docker power control. Start and restart are refused for suspended or terminated tenants |
| `/admin/reload` | `id` | Clears Laravel caches and reloads Octane workers |
| `/admin/upgrade` | `id` | Same as `/control/upgrade` with the node image |
| `/admin/resources` | `id`, `cpuLimit` (`"2.5"`, 0.1–64, or `null` for the node default) | Same as `/control/resources`: sets the tenant's CPU limit live with `docker update` and keeps it for recreations. The dashboard's **More actions → Change CPU limit** calls it |
| `/admin/resume` | `id`, `lifecycleVersion` | Resumes a suspended tenant from the node's own record (app key, licence, URL); the version must exceed the stored one |
| `/admin/database/download` | `id` | SQL export (primary node only) |

`/admin/fs` actions (paths are absolute container paths with no `.`, `..` or empty segments):

| `action` | Fields | Notes |
| --- | --- | --- |
| `list` | | Up to 5,000 entries with type, size, octal mode, `rwx` string, owner, group, mtime, symlink target, plus `persistent` and `writable` |
| `stat` | | One entry |
| `read` | | Up to 4 MB as `contentBase64`, with `binary`, `mode`, `modifiedAt` |
| `write` | `contentBase64` (≤ 4 MB), optional `expectModifiedAt` | Atomic replace that keeps mode and owner; `file_changed` (409) if the file changed since `expectModifiedAt` |
| `create` | | New empty file |
| `upload` | `uploadId` (16–64 hex), `offset`, `final`, `contentBase64` (≤ 6 MB per chunk), `overwrite` | Chunked; the file appears atomically on the final chunk |
| `mkdir` | `parents` | |
| `rename`, `copy` | `destination` | Refuses to overwrite |
| `delete` | `recursive` | `/`, top-level folders, `/var/www`, `/var/www/html` and `/var/www/html/storage` are refused |
| `chmod` | `mode` (`644`, `0755`, …), `recursive` | Recursive mode skips symlinks |
| `chown` | `owner` (`user[:group]` or numeric), `recursive` | Run as `root` |
| `extract` | `destination` | `.zip`, `.tar`, `.tar.gz`, `.tgz`, `.tar.bz2` and `.tar.xz`. Absolute paths, `..` and link entries are skipped and counted in `skipped` |

Errors are JSON `{"error": code}` with a matching status, for example `permission_denied` (403), `file_not_found` (404), `file_exists`, `directory_not_empty` and `protected_path`.

`/control/list` (signed with `ORIGIN_SECRET`, documented in [MANAGEMENT-API.md](MANAGEMENT-API.md)) returns the same tenant summaries for the master website.
