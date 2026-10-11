# Operator dashboard and admin API

The dashboard (`dashboard/`) is a private control panel for the people who run the nodes. It shows both nodes and every tenant with live CPU, memory, disk and container state, and for each tenant offers a file manager, a command console, container logs and operational controls: reload caches, restart, stop and start the container, upgrade to the node image, and download the database.

It talks to the node agents through a separate **admin API** (`/admin/*`), signed with its own `ADMIN_API_SECRET`.

## Security model

- **A separate secret.** `ORIGIN_SECRET` is shared with the routing Worker and the master website. The admin API can run commands and change any file in a tenant container, so it accepts only `ADMIN_API_SECRET`. That value lives on the nodes and in the dashboard and nowhere else. If it is missing, shorter than 32 characters, or equal to the origin or control secret, the agent logs `admin_api_disabled` and answers `/admin/*` with 404. Tenant traffic and `/control/*` keep working either way.
- **The browser never holds a node secret.** The dashboard server signs every node call. The browser gets an `HttpOnly`, `SameSite=Strict` session cookie, and every change also needs a CSRF token. Sign-in is rate limited (10 attempts per IP per 15 minutes, 60 per minute overall), and passwords are stored as scrypt hashes.
- **Where it is served.** The dashboard process listens only on `127.0.0.1:8790`. When `DASHBOARD_PROXY_PORT` is set in `node.env`, the agent also serves it at `https://<node hostname>/panel/` through the node's existing tunnel route, and redirects the bare hostname (`/`) there. Only `/panel` is forwarded; `/control`, `/admin`, `/tenant` and `/__cloud_node_health` behave exactly as before. The session cookie is limited to `Path=/panel`, and node credentials are never forwarded to the dashboard.
- **Two-factor sign-in.** With `DASHBOARD_TOTP_SECRET` set, sign-in also needs a 6-digit code from an authenticator app (RFC 6238). Each code is accepted once. The installer turns this on by default when the dashboard is served publicly.
- **Kernel-enforced permissions.** File and console operations run inside the tenant container as `www-data` by default. You can choose `root` per action. Root inside a container can use the bind-mounted MariaDB socket as the database root user, which reaches every tenant database on the node, so prefer `www-data`.
- **Audit trail.** The agent logs each admin call (`admin_authorized`, with tenant, operation, run-as user and file action, but never paths or commands). The dashboard logs sign-ins and each action, including the first 200 characters of console commands, to its journal and to the Activity page.
- **Billing state stays with the master website.** The dashboard can create instances (below) but does not suspend, terminate or resume tenants. If it did, lifecycle versions would conflict with the master website and the routing Worker would not learn the new state. "Stop" is a Docker-level stop for maintenance only.

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

## Creating instances

With `ORIGIN_SECRET` and `BASE_DOMAIN` in `dashboard.env`, the dashboard shows **Instances → Create instance**. Re-running `install-dashboard.sh` on a node copies both from `node.env` (and `NODE_CONTROL_SECRET` if the node uses that legacy override). Without them the page is hidden and the dashboard works as before. Set `ROUTING_API_URL` only if the routing API is not at `https://BASE_DOMAIN`, and `ROUTING_CONTROL_SECRET` only if the Worker uses that legacy override.

The form asks for the home region (`us` or `de`; it owns the database and cannot change), the domain, the Spartan licence key (the product is read from its prefix, as on the node), and an optional customer reference. The dashboard generates the tenant ID, `APP_KEY` and ownership fingerprint with the same recipe as [API.md](API.md), then follows its "Create a service" flow:

1. **Domain.** By default the routing Worker assigns `instance-NNNN.<zone>` (see "Default instance hostname" in [MANAGEMENT-API.md](MANAGEMENT-API.md)): the dashboard registers the tenant as `pending`, asks the Worker for the hostname, and Cloudflare attaches it as a Worker Custom Domain with DNS and a certificate. It is one level under the zone, so the free Universal certificate covers it (unlike `t-<id>.BASE_DOMAIN`). The licence for that hostname is entered on the deploy step, once the name is known. The hostname is the operator's, so the dashboard issues the node's provisioning permit itself. The Worker needs `CF_INSTANCE_API_TOKEN`, which `npm run configure` sets. A customer domain goes through the routing Worker's onboarding (`prepare`, then **Verify DNS** until it reports `readyToProvision`), exactly as in [MARKET_MODULE_API.md](MARKET_MODULE_API.md); the dashboard shows the DNS records to add and uses the permit the Worker issues. The licence must be issued for the chosen domain.
2. **Deploy.** Enter the first administrator. The dashboard calls `POST /control/provision` on the home node with the administrator, then on the other node without it, retrying while a node reports `provisioning` or is still working behind Cloudflare's 100-second limit, and finally publishes the tenant to the routing Worker as `ready` at lifecycle version 1. The page shows each step with its attempt count and elapsed time, the container's state and latest log lines from the node working on it (through the admin API), and a plain-language "What happened" log of every node answer, retry and DNS check (kept with the instance record). A failed deployment can be retried and continues where it stopped, with the same identity.

**Queue.** Pressing Deploy puts the instance in a queue. It starts when no other deployment is running on either of its nodes (a first boot is the heaviest thing a node does) and both nodes report at least `DASHBOARD_MIN_FREE_MEMORY_MB` (default 1024) free memory and `DASHBOARD_MIN_FREE_DISK_GB` (default 5) free disk through the admin API. The queue is re-checked every minute and after each deployment; the instance page shows its position and the current reason. A node at its `MAX_TENANTS` limit sends the deployment back to the queue instead of failing it. **Leave queue** returns it to ready. The queue lives in memory with the administrator password, so restarting the dashboard clears it (those instances show `dashboard_restarted`; deploy again).

Instance records (tenant ID, keys, licence, domain, status) are kept in `/var/lib/spartan-dashboard/instances.json`, mode 600, owned by the service. The administrator password is held in memory only while deploying and is never written to disk; if the dashboard restarts mid-deployment, deploy again. A draft that has not reached either node can be discarded.

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
