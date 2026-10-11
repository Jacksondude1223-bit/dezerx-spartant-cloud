# US-only database with WireGuard

Both regions run the Spartan web application. Every tenant database is hosted in the US MariaDB server. US containers use its Unix socket; Germany containers connect to `10.77.0.1:3306` through WireGuard. Germany has no running MariaDB server, no database socket mount, and no database fallback. Each tenant uses its own database and credentials. Germany does not receive MariaDB root credentials.

This is an explicit topology change, not something a weekly update check activates. Fresh installations configure and activate this topology automatically once both nodes and their firewalls are ready. Existing installations with tenant records stay in their previous mode until an operator runs the activation command. Use a maintenance window: US MariaDB restarts when its listener changes, and existing containers need environment updates and recreation. Preserve original tenant application keys and database passwords. The scripts never delete existing database files or tenant storage.

## Prerequisites

- Latest node installer/code on both hosts. Upload the latest root `install.sh` and rerun the US/DE installer in a maintenance window to install the `spartan-db-network` helper. A node-code-only update does not install this CLI helper.
- Rebuild and publish the latest `runtime/Dockerfile` with the complete Spartan application in `app/`. The new runtime clears a stale `DB_SOCKET` on Germany, synchronizes database environment values, and checks remote database connectivity from the application health endpoint. Set both nodes' `SPARTAN_IMAGE` to the new immutable digest before creating new tenants; existing tenants need an explicit image upgrade.
- Spartan must include its normal Laravel `sessions` database table migration. In this mode `SESSION_DRIVER=database`, so login sessions are shared across regions. Application health refuses readiness when the sessions table is missing. Only the US primary runs migrations and seeders.
- The routing Worker's `DATABASE_MODE=us-central` restores country-based regional routing for US-primary tenants. Checked-in Wrangler files enable it; `local` retains direct-primary routing. Before container migration, legacy DE containers still forward to US. Keep the Worker deployment command `npm run deploy` in `workers/`.
- Both nodes use the same control API key (`NODE_CONTROL_SECRET` if configured, otherwise `ORIGIN_SECRET`). Germany fetches credentials through signed HTTPS calls to the existing US tunnel hostname. Exempt that hostname from browser challenges/Browser Integrity Check and caching.
- All services in this mode must use `primary: "us"`. An existing tenant with a DE primary blocks activation; migrate its authoritative data separately first.
- The dedicated `10.77.0.0/30` network must not overlap existing host/Docker routes. The helper refuses overlaps rather than choosing another network silently.

## Automatic installer setup

Upload the latest `install.sh` into `/root` on both nodes. Run on US:

```bash
sudo bash /root/install.sh us --private
```

Run on Germany:

```bash
sudo bash /root/install.sh de --private
```

The installer asks for the other server's public IP in addition to the existing image, API secret and Cloudflare Tunnel prompts. You can install the two servers in either order. Use the same control secret on both, and set the two Cloudflare published application routes to `node-us.dezerx.cloud` and `node-de.dezerx.cloud`, each with service `http://127.0.0.1:8788`. Keep the signed node APIs outside interactive Cloudflare challenges.

The installer generates a root-only WireGuard private key, preserves it on reruns, and exchanges only public keys through signed HTTPS node API requests. It pins the discovered peer public key, configures the encrypted interface and scoped host firewall rules, then retries every 30 seconds while the other node or external firewall is not ready. It activates US MariaDB first; Germany waits for US central database readiness before disabling its local MariaDB service. The setup timer disables itself after success.

You must still add the Contabo firewall rules below: the installer has no access to your Contabo account. Provision new instances only after both network status commands show central database readiness. Use the rebuilt runtime image described in the prerequisites.

For non-interactive installs, add `--peer-ip` with the other node's public IP, for example:

```bash
sudo bash /root/install.sh us --github-token-file /root/github-token --env /root/node.env --token /root/tunnel-token --non-interactive --peer-ip DE_PUBLIC_IP
```

`--skip-db-network` preserves a legacy installation without scheduling network setup. Existing central configurations are preserved. Existing nodes with non-terminated tenant records never undergo automatic topology activation; use the manual procedure below in a maintenance window. The automatic installer does not recreate tenant containers, change database passwords, rotate application or backup encryption keys, or delete tenant data. Node updates and weekly checks do not activate this setup.

Inspect progress:

```bash
sudo journalctl -u spartan-db-network -n 30 --no-pager
sudo systemctl list-timers spartan-db-network.timer
```

If setup reports a changed peer key or a partially activated configuration, inspect the saved checkpoint and fix it manually. The timer refuses to replace a pinned peer key or repeatedly restart an already activated database.

## Manual setup for existing nodes

## Prepare keys on both nodes

US:

```bash
sudo spartan-db-network us prepare
```

Germany:

```bash
sudo spartan-db-network de prepare
```

Save each displayed **public** key. Private keys stay root-only on their originating hosts and are never printed. Repeating `prepare` preserves an existing key.

## Contabo Firewall

On US, allow inbound UDP `51820` only from Germany's public IP. On Germany, allow inbound UDP `51820` only from US's public IP. Keep SSH administration rules and outbound traffic allowed. Do not allow public TCP `3306`.

The setup also adds narrowly scoped host firewall rules. It does not replace the Contabo firewall, flush existing firewall rules, or change the default internet route. The encrypted interface only routes the opposite peer's VPN address.

## Configure the peers

US:

```bash
sudo spartan-db-network us configure
```

Enter Germany's public IP and Germany's WireGuard public key.

Germany:

```bash
sudo spartan-db-network de configure
```

Enter US's public IP and US's WireGuard public key.

The interface is `spartan-db`, with US `10.77.0.1` and Germany `10.77.0.2`. Germany's Docker database traffic is translated to `10.77.0.2` so US can restrict tenant accounts to that exact peer address. WireGuard starts automatically at boot.

## Activate US first

```bash
sudo spartan-db-network us activate
```

Activation verifies a recent VPN handshake, blocks new control operations, waits for existing operations, refuses concurrent backups, saves the old node environment/configuration, binds MariaDB only to its US VPN address (the local Unix socket remains available), adds tenant-scoped grants for the DE peer, and restarts the agent. MariaDB is ordered after WireGuard at boot.

Then activate Germany:

```bash
sudo spartan-db-network de activate
```

Germany verifies the US node is ready in central mode, stops and masks its local MariaDB service, disables local database backup jobs, enables the central database configuration, and restarts its agent. Its health check requires a recent VPN handshake and a reachable US database. A VPN/database failure never selects a local database.

Configuration files and database directories are preserved. Activation failures identify a checkpoint under `/etc/spartan-cloud/history`; inspect service logs and that checkpoint before retrying. This command does not automatically undo a partially completed topology change.

## Verify both hosts

US:

```bash
sudo spartan-db-network us status
```

Germany:

```bash
sudo spartan-db-network de status
sudo systemctl is-active mariadb
```

Germany's MariaDB must report inactive. Node health should report `databaseMode: "us-central"`, `databaseRegion: "us"`, and `databaseReady: true`.

## Provision new instances

Follow `MARKET_MODULE_API.md`. Verify the customer's domain and certificate first, obtain a fresh permit, then provision US with `primary: "us"` and the initial administrator. Wait for US to become ready before provisioning Germany with the same tenant ID, fingerprint, application key, URL and licence, and its own fresh domain permit if necessary. Publish ready routing only after both nodes are ready.

Germany securely retrieves the existing tenant database credentials from US; the master website does not invent or provide them. `/control/database/connection` is an internal signed endpoint and must never be called by frontend JavaScript or have its response logged. It only returns a matching, ready US tenant's scoped credentials. SQL download/export remains a US-primary operation.

## Existing instances

Activation leaves running containers unchanged. Until Germany's container has been recreated with the central database settings, its agent continues forwarding that tenant's requests to US.

For each instance, use the signed API in a maintenance window:

1. Obtain a fresh onboarding verification token for its current domain.
2. Reprovision US and Germany using their existing tenant identity, original application key and existing licence. This stages the new environment and obtains the original US database password on Germany; it does not create a second authoritative database.
3. Use `/control/upgrade` on both nodes with the rebuilt runtime image digest to recreate the containers with the staged environment. Wait for US readiness before recreating Germany.
4. Verify both application health checks and that instance information reports `databaseMode: "us-central"`, `databaseRegion: "us"`.

Do not create a new application key or delete the old US database. Switching from file sessions to database sessions can require users to sign in again.

On a DE container, verify the database connection without printing its credentials (replace the container name):

```bash
sudo docker exec --user www-data --workdir /var/www/html YOUR_CONTAINER_NAME php -r '
require "vendor/autoload.php";
$app = require "bootstrap/app.php";
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();
$connection = Illuminate\Support\Facades\DB::connection();
printf("Database host: %s\n", $connection->getConfig("host"));
printf("Database socket: %s\n", $connection->getConfig("unix_socket") ?: "none");
$row = $connection->selectOne("SELECT DATABASE() AS db, CURRENT_USER() AS account");
printf("Database: %s\nAccount: %s\n", $row->db, $row->account);
'
```

Expect host `10.77.0.1`, socket `none`, and a tenant account ending in `@10.77.0.2`. This is the live application-level verification; repository tests cannot establish the actual VPS network or image configuration.

## Operational limits

US is the only authoritative database. An outage there affects both regions, and Germany's queries incur transatlantic latency. Backups do not provide automatic database failover. A shared database does not replicate regional filesystem uploads, Modules or Themes: use shared object storage/file synchronization before relying on both regions for those files. Configure any application-specific database connections to the same US service; the node configures Laravel's default connection.
