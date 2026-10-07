# Spartan Cloud API reference

Powered by Costal Cloud

Based on the implementation at repository commit `0d60c324f84b4dceab6308f9290ce8474c5505d8`, reviewed October 7, 2026.

## Deployment model

The default Worker is a router. The master website provisions and manages Docker containers by calling each node, then publishes service state to the routing Worker. Registering a route does not create, stop, restart, or delete a container.

The routing Worker keeps its routing records and custom-domain registrations in a D1 database bound as `DB`, created by `npm run configure`. Earlier revisions kept them in Durable Objects; a Durable Object is billed for the wall-clock time it stays awake, so consulting one on every request kept an object warm per tenant. The Durable Object classes remain deployed only so existing registrations can be migrated out. Certificate monitoring runs from the Worker's cron trigger, every five minutes, because D1 has no alarms.

| API | Example base URL | Authentication |
| --- | --- | --- |
| Routing Worker | `https://dezerx-spartant-cloud.ACCOUNT.workers.dev` | HMAC using `ROUTING_CONTROL_SECRET` |
| US node | `https://node-us.yourdomain.com` | Control HMAC using `NODE_CONTROL_SECRET`; origin endpoints use `ORIGIN_SECRET` |
| Germany node | `https://node-de.yourdomain.com` | Same shared node and origin secrets |
| Optional provisioning Worker | `https://spartan-provisioning.ACCOUNT.workers.dev` | HMAC using `BILLING_WEBHOOK_SECRET` |
| Optional recovery endpoint | Provisioning Worker base URL | HMAC using `AI_RECOVERY_SECRET` |

Each tenant's application data lives in its own MariaDB database on the node, named `sp_` followed by the tenant ID's 24 hexadecimal characters, with a matching user restricted to that database. Containers reach MariaDB over its unix socket, whose directory is bind-mounted read-only; MariaDB never listens on a public interface and no root password is stored on the node. Per-tenant uploads stay on disk under `storage/`, which is the only per-tenant bind mount.

Replace every example hostname and credential. Secrets belong in server-side configuration; never send them to customer browsers. Use HTTPS for all public calls. Node tunnels forward HTTP internally to `127.0.0.1:8788`.

The routing API accepts its Workers.dev hostname, `BASE_DOMAIN`, or the configured `ROUTING_API_HOSTNAME`. Tenant hostnames are application routes, not control API base URLs.

The OpenAPI description is [openapi.json](openapi.json). It describes all API planes; each operation specifies the appropriate server. Swagger and Postman imports do not automatically calculate HMAC signatures.

## Authentication

Signed requests require these headers:

| Header | Value |
| --- | --- |
| `Content-Type` | `application/json` for POST bodies |
| `X-Spartan-Timestamp` | Unix timestamp in milliseconds, decimal string |
| `X-Spartan-Signature` | Lowercase hexadecimal HMAC-SHA256 |

Sign this exact sequence, with newline characters between the four components:

```text
timestamp + "\n" + METHOD + "\n" + pathname + "\n" + rawBody
```

Use the uppercase HTTP method and the URL pathname beginning with `/`. Exclude the hostname and query string from the signature. GET requests use an empty body. The accepted clock window is five minutes; synchronize server clocks. Compute the signature after serialization and send the exact bytes that were signed, including any final newline in a JSON file. Do not follow redirects with credentials.

The secrets are literal strings. Do not hex-decode a hex-looking secret before computing HMAC.

Signing verifies authenticity and freshness; it is not a one-time nonce system. Repeated requests within the clock window can be accepted. Lifecycle versions and stable identities protect service transitions against stale operations.

### Runnable Python request client

Save this as `api-request.py`. It uses Python's standard library. Set `SPARTAN_API_URL` and `SPARTAN_API_SECRET` in the environment of the master website or your terminal. Use the secret appropriate to the target API.

```python
import hashlib
import hmac
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

method, pathname = sys.argv[1:3]
body = Path(sys.argv[3]).read_bytes() if len(sys.argv) > 3 else b""
base = os.environ["SPARTAN_API_URL"].rstrip("/")
secret = os.environ["SPARTAN_API_SECRET"]
if not pathname.startswith("/") or "?" in pathname or "#" in pathname:
    raise SystemExit("Use a pathname without a query string or fragment")
if urllib.parse.urlsplit(base).scheme != "https":
    raise SystemExit("HTTPS is required")
stamp = str(int(time.time() * 1000))
message = (stamp + "\n" + method + "\n" + pathname + "\n").encode() + body
signature = hmac.new(secret.encode(), message, hashlib.sha256).hexdigest()
headers = {
    "Content-Type": "application/json",
    "X-Spartan-Timestamp": stamp,
    "X-Spartan-Signature": signature,
}
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, response_headers, newurl):
        return None
request = urllib.request.Request(base + pathname, data=body if method != "GET" else None, headers=headers, method=method)
try:
    with urllib.request.build_opener(NoRedirect).open(request, timeout=120) as response:
        print(response.status)
        print(response.read().decode())
except urllib.error.HTTPError as error:
    print(error.code)
    print(error.read().decode())
    raise SystemExit(1)
```

For example, after saving a registration body to `route.json`:

```bash
python3 api-request.py POST /v1/routing/instances route.json
python3 api-request.py GET /v1/routing/instances/t-111111111111111111111111
```

## IDs and shared provisioning state

Tenant IDs match `t-` followed by 24 lowercase hexadecimal characters. Service and customer IDs in the routing and optional provisioning APIs match `[A-Za-z0-9_-]{1,100}`.

For compatibility with the optional provisioning Worker, derive the tenant ID from the service ID:

```javascript
import {createHash, randomBytes} from 'node:crypto';
const serviceId = 'svc_1001';
const customerId = 'cus_42';
const primary = 'us';
const id = 't-' + createHash('sha256').update(serviceId).digest('hex').slice(0, 24);
const appKey = 'base64:' + randomBytes(32).toString('base64');
const fingerprint = createHash('sha256').update(JSON.stringify([serviceId, customerId, primary])).digest('hex');
```

For direct node provisioning, that fingerprint recipe is a recommended stable ownership fingerprint; the node validates its format and equality, not its derivation. Persist `id`, `appKey`, `fingerprint`, `primary`, `licenseKey`, and `lifecycleVersion` in the master website database. Use the same values on both nodes. Generate `appKey` once per service; do not regenerate it for retries or resume operations.

`url` is the tenant's own application URL, and it is the customer's domain: a Spartan licence is issued per domain, and the application identifies itself by `APP_URL`. Send `https://{id}.{BASE_DOMAIN}` while the customer has no domain yet, so the tenant can serve on its routing subdomain until one is pointed at us. Either way routing reaches the tenant through both hostnames, because the Worker forwards the visitor's own `Host`. The node accepts only a bare `https://host` with no port, path, query or credentials, and refuses `BASE_DOMAIN` itself and either node origin.

Prefer sending the customer's domain from the start. The vendor's own Docker kit puts no domain in the tenant's runtime environment other than `APP_URL`, so `APP_URL` is the only domain Spartan can present if it verifies its licence at run time. A tenant left on the routing subdomain is therefore running a licence issued for a domain it does not claim, and the vendor may refuse it. The subdomain is a way to get a tenant serving before DNS exists, not a long-term configuration: move it with a re-provision and an upgrade as soon as the customer's domain is verified.

`primary` is the writable database owner, not the visitor's location. Do not change it on an existing route or node record.

## Current master website flow

### Create a service

1. Confirm payment in the master website, ask the customer which domain the panel will run on, obtain the Spartan licence DezerX issues for that domain, and create persistent provisioning state.
2. Call `POST /control/provision` on the primary node with that domain as `url`, including the initial administrator details.
3. Wait for `status: ready`. If the response is `provisioning`, retry the same persisted request until ready or escalate the failure.
4. Call `POST /control/provision` on the other node with the same identity, key, fingerprint, and version. Omit `initialAdmin` on the secondary.
5. Wait for the secondary to return `ready`.
6. Register the routing record as `ready` using `POST /v1/routing/instances`.
7. Attach the customer's domain with `POST /v1/routing/instances/{id}/domains/reserve`, have them add the CNAME, then the same path with `verify`.
8. Return the tenant URL to the customer. Until their DNS resolves, the routing subdomain reaches the same tenant.

You can register `pending` before provisioning to show the service as unavailable during setup. A node HTTP 200 response is not by itself proof of readiness; check its JSON `status`.

### Suspend a service

Increase the persisted lifecycle version. Publish `suspended` to the routing Worker first, then send `action: suspended` with that version to both nodes. Retry any failed node operation with the same version. Containers are stopped and restart is disabled; persistent data remains.

### Resume a service

Increase the version again. Reuse `POST /control/provision` on both nodes with the original keys and fingerprint and the new version. When both are ready, publish `ready` with that version to the routing Worker. There is no `active` or `resume` action on `/control/lifecycle`.

### Terminate a service

Detach custom domains while the routing record is still ready; the domain API requires a ready tenant even for deletion. Then increase the version, publish `terminated`, and send `action: terminated` to both nodes. Containers are removed, but the tenant's MariaDB database, its `storage/` directory and its backups remain. Termination is irreversible for that tenant ID; it is not a full data-erasure API. If already suspended, the current domain API rejects deletion because the tenant is not ready; termination still blocks customer access, but retained domain records need separate reconciliation.

### Change the tenant's domain, rotate a licence, or change tenant environment

Docker reads an environment file once, when it creates a container, so rewriting it changes nothing by itself. Send `POST /control/provision` with the new `url` and the licence issued for it (or the new `licenseKey` alone, or after editing the node's `LARAVEL_ENV_FILE`) to rewrite `app.env`, then `POST /control/upgrade` to recreate the container so it takes effect. Re-provisioning a tenant that is already `ready` leaves it `ready` and leaves its container serving the old environment, so routing is not interrupted until the upgrade restarts it. The upgrade reports `changed: "environment"`. The tenant's database and `storage/` are untouched.

### Update Spartan

Build and push a new image, then take the digest from `scripts/build-image.sh`. Set it as `SPARTAN_IMAGE` on each node and restart the agent. New services pick it up automatically; existing ones need `POST /control/upgrade` per tenant. Run them one at a time and inspect each response, and keep the previous digest so you can set it back and upgrade again to roll a bad release forward.

## Node API

Node control bodies are limited to 16,384 bytes. Sign control requests with `NODE_CONTROL_SECRET`.

### POST /control/provision

Example request to the primary node:

```json
{
  "id": "t-111111111111111111111111",
  "primary": "us",
  "appKey": "base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  "url": "https://t-111111111111111111111111.cloud.yourdomain.com",
  "fingerprint": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "licenseKey": "SPARTANPROFESSIONAL_replace-with-the-issued-key",
  "lifecycleVersion": 0,
  "initialAdmin": {
    "displayName": "Customer Owner",
    "email": "owner@customer.example",
    "password": "Replace-this-password!"
  }
}
```

| Field | Requirement |
| --- | --- |
| `id` | Required tenant ID |
| `primary` | Required, `us` or `de`; identical on both nodes |
| `appKey` | Required, `base64:` followed by a base64-encoded 32-byte key |
| `url` | Required; the customer's domain as a bare `https://host`, or the tenant's `https://{id}.{BASE_DOMAIN}` subdomain before they have one |
| `fingerprint` | Required, 64 lowercase hexadecimal characters |
| `licenseKey` | Required; the Spartan licence issued for this service |
| `lifecycleVersion` | Nonnegative safe integer; defaults to zero if omitted |
| `initialAdmin` | Optional; supply on the primary when creating the first user |

The illustrated key, fingerprint and licence are placeholders, not values to deploy.

A Spartan licence is issued per domain, so each service needs its own. The master website obtains it from DezerX when the service is purchased and passes it here; the node does not mint, derive or share licences. It must begin with `SPARTANSTARTER_`, `SPARTANPROFESSIONAL_`, `SPARTANULTIMATE_` or `SPARTANDEV_` and otherwise contain only letters, digits, `_` and `-`, which is what the vendor's own download client accepts. `PRODUCT_ID` is derived from that prefix. The key is written only into the tenant's `app.env` and its state file, both mode 600, and is never logged or returned. Anything else is refused with `invalid_license_key`, which is not retried.

`initialAdmin` accepts exactly `displayName`, `email`, and `password`. Display name: nonblank, maximum 100 characters. Email: valid basic email format, maximum 254 characters. Password: 8–128 characters. Control characters are rejected. Do not include a `role` field. The container creates this user as **superadmin** using `php artisan dx:user:create`. Creation occurs only on the primary and is not repeated after initialization; this endpoint is not a password-reset API.

Example response, HTTP 200:

```json
{"id":"t-111111111111111111111111","status":"ready","role":"primary"}
```

`role` is `primary` or `secondary`; `status` may instead be `provisioning` after the startup health wait. Provisioning uses the digest-pinned image configured on the node. Image selection and container resource limits are node settings, not per-request fields.

### POST /control/lifecycle

```json
{
  "id": "t-111111111111111111111111",
  "fingerprint": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "lifecycleVersion": 1,
  "action": "suspended"
}
```

All fields are required. `action` is `suspended` or `terminated`; the version must be a safe integer of at least one. Send the operation to both nodes. A lifecycle action can create a suspension or termination record even when the service has not yet been provisioned, preventing a late create request from reviving it.

HTTP 200 response:

```json
{"id":"t-111111111111111111111111","status":"suspended","lifecycleVersion":1}
```

### POST /control/upgrade

```json
{
  "id": "t-111111111111111111111111",
  "fingerprint": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
}
```

Moves an existing tenant onto the image the node is configured with. `POST /control/provision` deliberately will not do this: it reuses a container that already exists, so a new `SPARTAN_IMAGE` otherwise reaches new tenants only.

Both fields are required. The call compares the running container's image to the node's `SPARTAN_IMAGE`, and the tenant's current `app.env` to the one its container was created from. When either differs it pulls the image, stops and removes the container, and recreates it with the same labels, limits, environment file and mounts. The tenant's database and `storage/` are untouched, and the recreated container's entrypoint runs `migrate --force`, so a release's migrations apply as part of the upgrade.

The pull happens **before** the container is stopped, so an unreachable or wrong digest fails while the tenant is still serving. Recreating a container assigns it a new host port; the agent re-reads and persists it.

| Response `status` | Meaning |
| --- | --- |
| `current` | Already on that image. Nothing was pulled, stopped or recreated. |
| `upgraded` | Recreated and healthy. `previousImage` names what it replaced, and `changed` is `image`, `environment` or `image_and_environment`. |
| `rolled_back` | The replacement would not start, so the previous image was put back and the tenant is serving again. `attempted` and `reason` say what failed. |
| `provisioning` | Recreated and started, but not healthy within the wait. **Not** rolled back: its entrypoint reached `migrate`, so reverting could leave the schema ahead of the code. Investigate before retrying. |

HTTP 200 response:

```json
{"id":"t-111111111111111111111111","status":"upgraded","previousImage":"registry/spartan@sha256:...","image":"registry/spartan@sha256:...","role":"primary"}
```

Upgrades are refused for a suspended tenant, because recreating its container would silently resume it, and for a terminated one. A tenant with no container is reported rather than created; use `POST /control/provision` for that. A fingerprint mismatch, or container labels that do not match the tenant, are refused as well.

Repeating the call is safe: once the tenant is on the target image the answer is `current`. Upgrade one tenant at a time so a bad release cannot take a whole node down, and check each response before moving on. Set `UPGRADE_HEALTH_ATTEMPTS` on the node to change how many seconds the health wait allows; the default is 60, and a slow migration can outlast the HTTP request, in which case a repeated call reports the outcome.

### GET /__cloud_node_health

Send `X-Spartan-Origin: {ORIGIN_SECRET}` rather than HMAC headers.

```json
{"status":"ready","region":"us"}
```

HTTP 200 confirms that the agent responds; it does not check every tenant container. Missing or incorrect origin credentials return HTTP 401. The installer separately checks Cloudflare Tunnel connectivity locally.

### /tenant/{id}/{applicationPath}

Internal proxy ingress used by the routing Worker. Required headers include `X-Spartan-Origin`, `X-Spartan-Client-IP`, and `X-Spartan-Host`. The Worker constructs them and discards spoofed incoming forwarding headers. Custom domains additionally use `X-Spartan-Custom-Domain: 1`. Customers visit the public tenant hostname directly and do not call this endpoint or supply these credentials.

## Routing Worker API

Bodies are limited to 65,536 bytes. Sign all `/v1/routing/*` requests with `ROUTING_CONTROL_SECRET`.

### POST /v1/routing/instances

```json
{
  "id": "t-111111111111111111111111",
  "serviceId": "svc_1001",
  "customerId": "cus_42",
  "primary": "us",
  "status": "ready",
  "lifecycleVersion": 0
}
```

All six fields are required. Allowed status values are `pending`, `ready`, `active`, `suspended`, and `terminated`. `active` is normalized to `ready`. The response is the stored record; new records return HTTP 201 and updates return HTTP 200.

`id`, `serviceId`, `customerId`, and `primary` cannot change after registration. Versions must increase for a status change. Repeating the same status and version is allowed. An older version, or a different status with the same version, returns HTTP 409 `stale_operation`. A terminated record cannot be revived.

### GET /v1/routing/instances/{id}

Sign with an empty body. Returns the stored routing record or HTTP 404 `not_found`. This is routing metadata, not live container inspection.

### POST /v1/routing/instances/{id}/domains/{action}

Supported actions: `reserve`, `verify`, `status`, `delete`. All four actions are POST requests with this body:

```json
{"hostname":"billing.customer.com"}
```

The tenant must be `ready`. Hostnames are lowercased and a trailing dot is removed. Maximum length is 200 characters. Wildcards, the SaaS zone itself and its subdomains, the tenant base domain and its subdomains, and node origin hostnames and their subdomains are reserved.

Domain ownership is tenant-specific. A hostname held by a different tenant returns HTTP 409 `hostname_conflict`.

### Custom domain and managed SSL workflow

1. Call `reserve`. A new reservation returns HTTP 201; an existing reservation for the same tenant returns HTTP 200.
2. Show the returned `ownership` TXT record and `cname` record to the customer. Use the returned target exactly. The returned CNAME instructions specify DNS-only (`proxied: false`) at the customer's DNS provider.
3. Call `verify` after DNS changes propagate. Until the TXT proof is visible, the API returns HTTP 409 `ownership_not_verified` with the domain details.
4. Publish any additional `cloudflareOwnership` or `certificateValidation` records returned by Cloudflare.
5. Poll `status` or retry `verify` until `status` is `active` and `certificateStatus` is `active`. Background monitoring also retries verification.
6. Call `delete` to detach the hostname and its Cloudflare custom-hostname registration. This does not remove the tenant containers or the customer's DNS records.

A first reservation response can look like:

```json
{
  "hostname": "billing.customer.com",
  "tenantId": "t-111111111111111111111111",
  "status": "pending_ownership",
  "cname": {"type":"CNAME","name":"billing.customer.com","target":"cloud.yourdomain.com","proxied":false},
  "ownership": {"type":"TXT","name":"_spartan-verification.billing.customer.com","value":"returned-verification-token"},
  "ssl": {"provider":"cloudflare","managed":true,"automaticRenewal":true,"method":"http","status":"pending","nextCheckAt":1791379200000}
}
```

Optional fields are omitted until known. Domain statuses include `pending_ownership`, `pending_certificate`, `active`, and `deleting`. Successful deletion returns `{"deleted":true}`. A verify HTTP 200 can still mean `pending_certificate`; inspect the body.

Cloudflare for SaaS configuration, the zone ID, API token, fallback origin, and DNS/Worker routes must already be configured. The repository's local custom-hostname limit defaults to 30. The implementation also guards against reaching 100 registrations using Cloudflare's reported quota and a count of the hostnames it currently holds; deleting a hostname frees its slot. These are code limits, not a guarantee about your Cloudflare plan or bill.

Two verify calls for the same hostname cannot both register it: only the caller that claims the registration attempt contacts Cloudflare, and the other receives the current record. Poll `status` after `verify`, as step 5 above already requires.

### POST /v1/routing/migrate/domains

One-shot migration, signed with `ROUTING_CONTROL_SECRET` and an empty JSON object as the body. Copies custom-domain registrations out of the pre-D1 Durable Object into D1 and reports `{"found":N,"imported":N}`. Replaying it imports nothing further, so it is safe to repeat.

Routing records cannot be migrated this way, because a Durable Object namespace cannot be enumerated by name. Re-register each tenant with `POST /v1/routing/instances` from the master website, which is the authoritative source for that state. `scripts/migrate-routing.mjs` does both halves.

### GET /__routing_status

Public JSON diagnostics on the routing control hostname. No signature is required. Returns the request hostname, visitor IP, country, Cloudflare location, selected node, connection state, and check timestamp. Root `/` serves the meme/status page. This is not a tenant enumeration endpoint.

## Routing behavior and current limits

The Worker selects Germany for the country set in `workers/shared.js`; other countries use the US node. It does not currently implement measured latency, health-based failover, or automatic primary promotion.

The primary owns the tenant's MariaDB database, and its node agent serves the application. A node where the tenant is not primary forwards **all application requests** to the primary rather than serving them locally, so a regional route does not mean the application executes in that region. There is no cross-node data replication: a non-primary node holds no tenant data at all. Do not treat this as an active-active database or an automatic failover setup.

Customer request outcomes include HTTP 403 `service_suspended`, HTTP 410 `service_terminated`, HTTP 503 `provisioning`, HTTP 503 `client_ip_unavailable`, and HTTP 503 `origin_unavailable`. Unmapped browser requests can return the status page with HTTP 404; unmapped API requests return JSON `not_found`.

## Optional provisioning Worker API

These endpoints require a separately deployed `workers/provisioning.js`. They do not exist on the default routing-only Worker. Choose a single provisioning controller per service; do not mix separately generated state from the master website with this controller's internal state.

The optional Worker stores provisioning state and asynchronously provisions the primary, then the secondary. HTTP 202 means accepted, not complete. Its public responses do not expose `appKey` or `fingerprint`. Its own tenant registry is separate from the routing-only Worker's registry; it does not automatically register records in that router.

| Method | Path | Body / purpose |
| --- | --- | --- |
| POST | `/v1/instances` | `{serviceId, customerId, primary, licenseKey, domain?, initialAdmin?}`; reserve and queue provisioning |
| GET | `/v1/instances/{id}` | Empty body; inspect provisioning status |
| POST | `/v1/services/status` | `{serviceId, status}`; desired status `active`, `suspended`, or `terminated` |
| POST | `/v1/instances/{id}/lifecycle` | `{status, serviceId?}`; same lifecycle operation by tenant ID |
| POST | `/v1/instances/{id}/app-url` | `{domain, licenseKey}`; move a ready tenant to a new domain and the licence issued for it |
| POST | `/v1/instances/{id}/domains/{action}` | `{hostname}`; the same four domain actions using this Worker's own registry |

Sign these requests with `BILLING_WEBHOOK_SECRET`. Request bodies are limited to 16,384 as enforced by Content-Length and the Worker's decoded body-length check. `primary` is required in raw create requests; the PHP helper defaults it to `us`.

Example create body:

```json
{"serviceId":"svc_1001","customerId":"cus_42","primary":"us","licenseKey":"SPARTANPROFESSIONAL_replace-with-the-issued-key","domain":"panel.customer.example","initialAdmin":{"displayName":"Customer Owner","email":"owner@customer.example","password":"Replace-this-password!"}}
```

`licenseKey` is required and is validated exactly as the node validates it, so an unusable key is refused with `invalid_license_key` before a tenant is reserved. `domain` is an optional bare hostname — no scheme, port or path — and becomes the tenant's `APP_URL`; omit it and the tenant uses `https://{id}.{BASE_DOMAIN}` until the customer has a domain. The control host and both node origins are refused with `invalid_domain`.

Neither the licence nor the domain is part of the ownership fingerprint, because both change over a service's life. That also means a repeated create does not change them: `POST /v1/instances` is idempotent and returns the existing record. Use `POST /v1/instances/{id}/app-url` to move a tenant, which requires a `ready` tenant (`service_not_ready` otherwise), keeps it `ready` throughout, and queues a rewrite plus a single container restart on each node. Reserve and verify the hostname through the domain API as well, so Cloudflare terminates TLS for it.

Example HTTP 202 response:

```json
{"id":"t-111111111111111111111111","serviceId":"svc_1001","primary":"us","status":"pending","desiredStatus":"active","lifecycleVersion":0,"url":"https://t-111111111111111111111111.cloud.yourdomain.com","createdAt":"2026-10-07T12:00:00.000Z"}
```

The ID shown is illustrative; real IDs are derived from the service ID. Poll GET status until `ready`. Intermediate states include `pending`, `suspending`, and `terminating`; terminal operation states include `ready`, `suspended`, and `terminated`. `readyAt` is returned once available. Repeated identical requests reuse the record; conflicting customer, primary, or initial-administrator details return `service_conflict`. Changing the original administrator credentials is not a retry mechanism.

After create or a lifecycle operation finishes, publish the resulting state to the default routing Worker using `ROUTING_CONTROL_SECRET`. Maintain domain registrations in the routing Worker when using it as your customer-facing router; creating a domain only in the optional controller does not populate the standalone router's domain registry.

## Optional Llama recovery API

### POST /v1/recovery

This endpoint lives on the optional provisioning Worker and uses `AI_RECOVERY_SECRET`. The routing-only Worker does not host recovery. Enable it only when that endpoint is deployed and configured.

```json
{
  "stage": "pull",
  "signals": ["transient_network"],
  "container": {"exists":false,"running":false,"oomKilled":false,"exitCode":null}
}
```

The diagnostic must contain exactly `stage`, `signals`, and `container`; the container object must contain exactly the four illustrated keys. No raw logs, passwords, arbitrary commands, or tenant data are accepted in this diagnostic schema.

Stages: `prepare`, `pull`, `launch`, `start`, `health`. Signals: `permissions`, `stale_cache`, `transient_network`, `db_locked`, `missing_dependency`, `migration_error`, `disk_full`, `out_of_memory`; maximum eight unique entries. `exitCode` is null or an integer from 0 through 255.

HTTP 200 response:

```json
{"action":"retry_pull","confidence":0.95}
```

Actions are `repair_permissions`, `clear_cache`, `retry_pull`, `start_container`, `restart_container`, `retry_deployment`, or `manual`. The Worker selects only actions permitted by diagnostics; nodes execute a bounded allowlist rather than model-written commands. Unsupported or uncertain repairs return `manual`. The model is `@cf/meta/llama-3.1-8b-instruct`. Calls are limited to the configured 1–20 per UTC day and at least 60 seconds apart globally. Diagnostics for which only `manual` is permitted do not consume a model call.

## Tenant databases and backups

One MariaDB serves every tenant on a node. Provisioning creates the tenant's database and user if absent and resyncs the user's password, so repeating a provision call is safe. The password is generated and held by the node in its tenant state file; it is never accepted or returned by the control API.

`MAX_USER_CONNECTIONS` is set to 20 per tenant so one tenant cannot exhaust the server, and the installer raises `max_connections` to 500. A shared server is a shared failure domain: a tenant running expensive queries can affect its neighbours, and MariaDB offers no per-user CPU limit.

An hourly systemd timer writes, per tenant, a `mysqldump --single-transaction` of the database, a tar of `storage/`, and copies of `app.env` and `state.json` into `/srv/spartan-backups/{id}/{timestamp}/`, finishing with a `complete` marker. A tenant whose backup fails is reported and skipped without stopping the others, and the run exits non-zero. Set `BACKUP_KEEP` to retain only that many completed backups per tenant; unset or `0` keeps all of them.

Backups are written to the same machine as the data they protect. Copy them off the node if you want them to survive losing it, and restore one periodically — a dump that has never been restored is not a verified backup.

## Responses, retries, and operational errors

| HTTP status | Interpretation |
| --- | --- |
| 200 / 201 | Request handled; inspect body state for readiness or certificate status |
| 202 | Optional provisioning operation accepted and still pending |
| 400 | Worker validation or JSON error |
| 401 | Invalid signature, stale timestamp, or incorrect health-check origin credential |
| 404 | Unknown route, tenant, domain, or unauthorized internal ingress |
| 409 | Ownership conflict, stale version, unready tenant, domain proof pending, or quota guard |
| 413 | Request or diagnostic too large |
| 429 | Optional recovery rate or daily budget limit |
| 500 | Optional provisioning Worker's internal failure |
| 503 | Node operation failed, origin unavailable, or domain/recovery operation unavailable |

Errors usually have `{"error":"code"}`. Domain ownership errors also include the public domain record. The node currently collapses most provisioning/lifecycle validation and operational failures into HTTP 503 `operation_failed`, with a more specific code in its server log. Do not assume every node 503 is a transient network failure.

Retry connection failures and genuine transient failures with bounded backoff and a newly signed timestamp. Preserve identity, keys, initial-administrator payload, and lifecycle version for retries. A changed desired state needs a newer version. Reconcile both nodes and routing metadata after partial failures. Do not retry termination by creating a new record with the same tenant ID.

Cloudflare browser challenges should target customer browser traffic. Exclude master control requests, node-origin traffic, health probes, billing webhooks, and application API integrations from browser challenges. A challenge page is HTML and cannot be completed by these API clients.

## PHP integration helpers

The repository contains `scripts/SpartanCloudRouter.php` for routing and domain operations, and `scripts/SpartanCloudProvisioner.php` for the optional provisioning controller. They are server-side PHP cURL clients using the same signatures described above.

```php
require 'scripts/SpartanCloudRouter.php';
$router = new SpartanCloudRouter(getenv('SPARTAN_ROUTING_URL'), getenv('ROUTING_CONTROL_SECRET'));
$record = $router->register($tenantId, $serviceId, $customerId, 'us', 'ready', 0);
$reservation = $router->domain($tenantId, 'billing.customer.com', 'reserve');
```

The provisioning helper is for the optional Worker, not for direct node calls. There is currently no node tenant-list API, per-tenant node status API, data-purge API, primary migration API, or administrator password-reset API.
