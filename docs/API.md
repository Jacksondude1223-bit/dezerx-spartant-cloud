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

For direct node provisioning, that fingerprint recipe is a recommended stable ownership fingerprint; the node validates its format and equality, not its derivation. Persist `id`, `appKey`, `fingerprint`, `primary`, and `lifecycleVersion` in the master website database. Use the same values on both nodes. Generate `appKey` once per service; do not regenerate it for retries or resume operations. The application URL must be exactly `https://{id}.{BASE_DOMAIN}` even when a custom domain is attached.

`primary` is the writable database owner, not the visitor's location. Do not change it on an existing route or node record.

## Current master website flow

### Create a service

1. Confirm payment in the master website and create persistent provisioning state.
2. Call `POST /control/provision` on the primary node, including the initial administrator details.
3. Wait for `status: ready`. If the response is `provisioning`, retry the same persisted request until ready or escalate the failure.
4. Call `POST /control/provision` on the other node with the same identity, key, fingerprint, and version. Omit `initialAdmin` on the secondary.
5. Wait for the secondary to return `ready`.
6. Register the routing record as `ready` using `POST /v1/routing/instances`.
7. Return the tenant URL to the customer; optionally attach a custom domain.

You can register `pending` before provisioning to show the service as unavailable during setup. A node HTTP 200 response is not by itself proof of readiness; check its JSON `status`.

### Suspend a service

Increase the persisted lifecycle version. Publish `suspended` to the routing Worker first, then send `action: suspended` with that version to both nodes. Retry any failed node operation with the same version. Containers are stopped and restart is disabled; persistent data remains.

### Resume a service

Increase the version again. Reuse `POST /control/provision` on both nodes with the original keys and fingerprint and the new version. When both are ready, publish `ready` with that version to the routing Worker. There is no `active` or `resume` action on `/control/lifecycle`.

### Terminate a service

Detach custom domains while the routing record is still ready; the domain API requires a ready tenant even for deletion. Then increase the version, publish `terminated`, and send `action: terminated` to both nodes. Containers are removed, but data directories and backups remain. Termination is irreversible for that tenant ID; it is not a full data-erasure API. If already suspended, the current domain API rejects deletion because the tenant is not ready; termination still blocks customer access, but retained domain records need separate reconciliation.

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
| `url` | Required, exact generated tenant URL |
| `fingerprint` | Required, 64 lowercase hexadecimal characters |
| `lifecycleVersion` | Nonnegative safe integer; defaults to zero if omitted |
| `initialAdmin` | Optional; supply on the primary when creating the first user |

The illustrated key and fingerprint are placeholders, not values to deploy.

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

### GET /__cloud_node_health

Send `X-Spartan-Origin: {ORIGIN_SECRET}` rather than HMAC headers.

```json
{"status":"ready","region":"us"}
```

HTTP 200 confirms that the agent responds; it does not check every tenant container. Missing or incorrect origin credentials return HTTP 401. The installer separately checks Cloudflare Tunnel connectivity locally.

### GET /replica/{id}

Internal node-to-node endpoint. Requires `X-Spartan-Origin`. Returns an SQLite snapshot as `application/octet-stream`, only from the ready primary. It is not a customer API. Missing authorization, invalid ID, or an unavailable primary record returns HTTP 404.

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

The primary owns writable SQLite data. The secondary synchronizes SQLite snapshots, but its node agent currently forwards **all application requests** to the primary rather than serving them locally. A regional route therefore does not currently guarantee that the application is executed in that region. Do not treat this as an active-active database or independent failover setup.

Customer request outcomes include HTTP 403 `service_suspended`, HTTP 410 `service_terminated`, HTTP 503 `provisioning`, HTTP 503 `client_ip_unavailable`, and HTTP 503 `origin_unavailable`. Unmapped browser requests can return the status page with HTTP 404; unmapped API requests return JSON `not_found`.

## Optional provisioning Worker API

These endpoints require a separately deployed `workers/provisioning.js`. They do not exist on the default routing-only Worker. Choose a single provisioning controller per service; do not mix separately generated state from the master website with this controller's internal state.

The optional Worker stores provisioning state and asynchronously provisions the primary, then the secondary. HTTP 202 means accepted, not complete. Its public responses do not expose `appKey` or `fingerprint`. Its own tenant registry is separate from the routing-only Worker's registry; it does not automatically register records in that router.

| Method | Path | Body / purpose |
| --- | --- | --- |
| POST | `/v1/instances` | `{serviceId, customerId, primary, initialAdmin?}`; reserve and queue provisioning |
| GET | `/v1/instances/{id}` | Empty body; inspect provisioning status |
| POST | `/v1/services/status` | `{serviceId, status}`; desired status `active`, `suspended`, or `terminated` |
| POST | `/v1/instances/{id}/lifecycle` | `{status, serviceId?}`; same lifecycle operation by tenant ID |
| POST | `/v1/instances/{id}/domains/{action}` | `{hostname}`; the same four domain actions using this Worker's own registry |

Sign these requests with `BILLING_WEBHOOK_SECRET`. Request bodies are limited to 16,384 as enforced by Content-Length and the Worker's decoded body-length check. `primary` is required in raw create requests; the PHP helper defaults it to `us`.

Example create body:

```json
{"serviceId":"svc_1001","customerId":"cus_42","primary":"us","initialAdmin":{"displayName":"Customer Owner","email":"owner@customer.example","password":"Replace-this-password!"}}
```

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

Stages: `prepare`, `pull`, `launch`, `start`, `health`, `replica`. Signals: `permissions`, `stale_cache`, `transient_network`, `sqlite_locked`, `missing_dependency`, `migration_error`, `disk_full`, `out_of_memory`; maximum eight unique entries. `exitCode` is null or an integer from 0 through 255.

HTTP 200 response:

```json
{"action":"retry_pull","confidence":0.95}
```

Actions are `repair_permissions`, `clear_cache`, `retry_pull`, `start_container`, `restart_container`, `retry_deployment`, or `manual`. The Worker selects only actions permitted by diagnostics; nodes execute a bounded allowlist rather than model-written commands. Unsupported or uncertain repairs return `manual`. The model is `@cf/meta/llama-3.1-8b-instruct`. Calls are limited to the configured 1–20 per UTC day and at least 60 seconds apart globally. Diagnostics for which only `manual` is permitted do not consume a model call.

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

Cloudflare browser challenges should target customer browser traffic. Exclude master control requests, node-origin traffic, health probes, replication, billing webhooks, and application API integrations from browser challenges. A challenge page is HTML and cannot be completed by these API clients.

## PHP integration helpers

The repository contains `scripts/SpartanCloudRouter.php` for routing and domain operations, and `scripts/SpartanCloudProvisioner.php` for the optional provisioning controller. They are server-side PHP cURL clients using the same signatures described above.

```php
require 'scripts/SpartanCloudRouter.php';
$router = new SpartanCloudRouter(getenv('SPARTAN_ROUTING_URL'), getenv('ROUTING_CONTROL_SECRET'));
$record = $router->register($tenantId, $serviceId, $customerId, 'us', 'ready', 0);
$reservation = $router->domain($tenantId, 'billing.customer.com', 'reserve');
```

The provisioning helper is for the optional Worker, not for direct node calls. There is currently no node tenant-list API, per-tenant node status API, data-purge API, primary migration API, or administrator password-reset API.
