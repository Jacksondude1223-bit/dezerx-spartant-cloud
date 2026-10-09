# Master website management API

All node operations below are `POST` requests to either `https://node-us.dezerx.cloud` or `https://node-de.dezerx.cloud`. Sign the exact JSON body with the shared `ORIGIN_SECRET` using the timestamp and HMAC headers documented in [API.md](API.md#authentication). A configured legacy `NODE_CONTROL_SECRET` overrides that key on nodes; a legacy `ROUTING_CONTROL_SECRET` overrides it on the routing Worker. Never send these shared secrets to customer browsers. The master website must authenticate the customer and check service ownership before calling any of these endpoints.

For instance operations, include `id` and `fingerprint`, the stable identities saved by the master website when provisioning. Use the same identities on both nodes. Health endpoints describe the node you called, so call both nodes to display both regions. SQL exports must be requested from the instance's primary node.

| Node endpoint | Additional JSON fields | Result |
| --- | --- | --- |
| `/control/node-health` | No identity required; send `{}` | Node region, Docker and database readiness, CPU cores/usage/load, memory bytes, disk bytes, uptime |
| `/control/instance` | None | URL, active URL, role, primary region, service status, image, running state, lifecycle version |
| `/control/health` | None | Instance information, Docker CPU/memory/network/block I/O/process statistics, application health |
| `/control/version` | None | Image reference and the parsed `/var/www/html/versions.json` as `versions` |
| `/control/upgrade` | Optional `image` | Pull and recreate only this instance using the requested image digest |
| `/control/database/download` | None | SQL attachment containing only this instance's database |
| `/control/files` | `action`, `path`, and operation-specific fields | Restricted file manager |
| `/control/domain` | `url`, `licenseKey` | Change the instance's canonical domain and recreate its container |
| `/control/reload` | None | Clear Laravel caches and reload Octane workers |
| `/control/provision` | Existing provisioning fields | Provision or resume this instance |
| `/control/lifecycle` | `action`, `lifecycleVersion` | Suspend or terminate this instance |

Example identity body:

```json
{"id":"t-111111111111111111111111","fingerprint":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
```

Health information does not return database passwords, app keys, licences or environment contents. Node CPU usage is sampled once per second and can be null immediately after agent startup. Container CPU percentage is Docker's percentage and can exceed 100% when more than one CPU is used. Memory, network and block I/O usage strings retain Docker's units. A stopped container returns `running: false` and `resources: null`. Application health tests the local container; a secondary container's check does not prove the primary database or primary forwarding path is healthy. There is no historical metrics database. Health reports `degraded` when Docker or MariaDB is unavailable. `versions.json` must be valid JSON, at most 64 KiB, readable by uid 33, and present at the application root; it cannot be a symlink. The version endpoint requires a running container and returns the file's JSON shape without inventing a version field.

## Default instance hostname

The routing Worker allocates `instance-1000.dezerx.cloud` through `instance-9999.dezerx.cloud`. Names are random, unique, stable across retries and never recycled after termination. Internal IDs remain `t-` plus 24 hexadecimal characters. Number-space exhaustion returns a conflict; Cloudflare's own account/domain limits still apply.

Set the Worker secret `CF_INSTANCE_API_TOKEN` to a Cloudflare token authorized to attach Worker Custom Domains in this account. The token needs account Workers Scripts Edit and access to the `dezerx.cloud` zone; add zone DNS Edit and Zone Read for domain/DNS management. The configured account, zone, Worker name and `INSTANCE_DOMAIN` are in `wrangler.toml`. The configure script writes this secret using `CF_INSTANCE_API_TOKEN` when supplied, otherwise its existing `CLOUDFLARE_API_TOKEN`. This is a Cloudflare infrastructure credential, separate from the shared master API key. Customer-owned domains continue using `CF_SAAS_API_TOKEN` and the existing SaaS verification APIs.

Provisioning sequence:

1. Register a `pending` route with `POST /v1/routing/instances` using the service/customer identities and chosen primary region.
2. Call `POST /v1/routing/instances/{id}/hostname` on the routing Worker with `{}`. Sign it using the shared API key. The Worker reserves the name in D1 and attaches it as a Worker Custom Domain. Cloudflare manages its DNS and TLS. A failed Cloudflare call returns `503`, the reserved hostname and `retryable: true`; repeat this call with the same ID. The operation refuses a hostname attached to another Worker.
3. Use the returned `url` when obtaining the domain-bound Spartan licence and sending `/control/provision` to both nodes. Create the initial superadmin only on the primary node.
4. Publish `ready` only after both nodes report ready. DNS and certificate issuance can still be pending after attachment; wait for HTTPS availability before showing the instance as externally available.

Example hostname response:

```json
{"id":"t-111111111111111111111111","hostname":"instance-1234.dezerx.cloud","url":"https://instance-1234.dezerx.cloud","status":"active","ssl":"cloudflare_managed","certificateMayBePending":true}
```

Use `npm run deploy` for Worker deployments. It applies and verifies `0002_instance_hostnames.sql`, reads the allocated names from remote D1 and includes their Custom Domains in generated deployment configuration. Do not run bare `wrangler deploy`, which omits dynamically allocated domains. Pause new hostname allocations during Worker deployment so a name added after the deployment snapshot is not removed by the same deployment. Names and mappings remain after service termination and route status blocks access.

## Customer-owned domain

Use the routing Worker endpoints `/v1/routing/instances/{id}/domains/reserve`, `/verify`, and `/status`, as documented in [API.md](API.md#routing-worker-api). The customer adds the returned CNAME and TXT proof. Wait until the domain and certificate are active before changing the application URL.

Obtain a licence issued for the new customer domain. Then call `/control/domain` on both nodes with:

```json
{"id":"t-111111111111111111111111","fingerprint":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","url":"https://billing.customer.com","licenseKey":"SPARTANPROFESSIONAL_replace-with-the-domain-licence"}
```

The endpoint uses the current tenant image, preserves the database, storage and application encryption key, rewrites the desired environment and recreates the container. Check the response before reporting success. It is not an atomic transaction across both nodes; the master website coordinates retries and keeps track of partial success. Each recreation interrupts that container briefly. The default hostname remains a route and redirects to the active canonical domain; POSTs to a noncanonical hostname return 421. The node endpoint trusts the signed master request to have completed DNS ownership verification. It does not independently verify a customer domain or issue a Spartan licence.

## Select an image or revert

```json
{"id":"t-111111111111111111111111","fingerprint":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","image":"ghcr.io/dezer-x/dezerx-spartan@sha256:b681836d7bb0bae11e26891d3431f50ce5f35daf9a5efbf0bb45ffa10924ea9a"}
```

Send to `/control/upgrade` on each node. Every supplied image must have an immutable SHA256 digest; tags are refused. This changes only the identified tenant, not the node's default image or other tenants. Omitting `image` retains the existing behavior of upgrading to the node's configured `SPARTAN_IMAGE`. Successful explicit selection is saved per tenant and retained during later reprovisioning. Pull failure leaves the running container alone. The instance must be ready; suspended and terminated services cannot be upgraded.

The container stops during replacement. A launch failure attempts the old image, but a started replacement may already have applied migrations and is not automatically reverted after health failure. Sending an older digest reverts application code only; it does not downgrade database schema. Export the SQL first and use releases whose schema is backward compatible. Persistent module and theme content is retained, so image changes do not overwrite it; update bundled modules/themes separately if the release requires it.

## Download SQL

Send the identity body to `/control/database/download` on the primary node. The successful response is `application/sql`, with an attachment filename `{id}.sql`. Stream it through the master website to the authorized customer; do not JSON-decode it. The export uses MariaDB's transactional, nonlocking dump options. Transactional tables have a consistent snapshot, but concurrent DDL or nontransactional tables can affect consistency.

The node prepares a private temporary dump, checks completion before sending a successful response, and removes it after transfer or failure. Only one export runs at a time per node; another returns `export_in_progress` with HTTP 429. Exports are limited to 1 GiB or half the available temporary-disk space, whichever is smaller, and five minutes. A secondary node returns `primary_node_required`. No other tenant or global database is included. Proxy response timeouts can be shorter than the node's export limit; large exports may need a direct authenticated node connection. The service can be suspended while its retained primary database is exported; termination blocks this API even though retained data still exists.

## File manager

The UI root contains exactly `/Modules`, `/Themes` and `/.env`. All operations use `/control/files` and the identity body. File contents are base64 encoded in JSON. File uploads/downloads are limited to 4 MiB; environment files are limited to 64 KiB. Parent folders must exist. Paths are case sensitive; `/themes` is not `/Themes`.

```json
{"id":"t-111111111111111111111111","fingerprint":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","action":"list","path":"/Modules"}
```

| Action | Fields and behavior |
| --- | --- |
| `list` | `path`: directory; response contains `entries` with name, type, size and modification time |
| `download` | `path`: file; response contains `contentBase64` |
| `upload` | `path`: file, `contentBase64`; replaces atomically or creates a file |
| `mkdir` | `path`: new directory |
| `rename` | `path`, `destination`; destination must not exist and must remain within the same root folder |
| `delete` | `path`: file or empty directory; remove children individually before deleting a folder |

The two root folders cannot be deleted, renamed or replaced. Traversal, symlink/hardlink file access and special files are refused. A fixed container-root bootstrap command gives uid 33 ownership of the application root directory; file operations then run inside the identified container as uid 33. No customer-supplied command is executed by that bootstrap. The helper initializes persistent copies under the tenant's existing storage volume and links the live folder atomically. These folders must remain readable and writable by uid 33. Containers need Python 3 and Linux `renameat2`, both present in the repository runtime. Rebuild the Spartan image with the updated `runtime/vendor-entrypoint.sh` so future container recreations relink these persistent folders at startup. Editing an older image works for its current container, but that older startup script does not restore the links after recreation. The data remains on its storage volume. Module/theme mutations return `needsReload`; call `/control/reload` when appropriate. New modules can require vendor-specific installation, assets or package registration beyond file upload.

`/.env` represents the node-managed desired application environment. Download it, modify supported values and upload it. Changes to encryption keys, database configuration, licensing, canonical URL, tenant identity, production/debug policy, Octane and session security are refused. Use the dedicated domain API for URL/licence changes. `.env` cannot be deleted or renamed. An accepted upload returns `needsApply: true`: call `/control/upgrade` with the instance's current image digest to recreate it and apply the new environment. `/control/reload` alone does not apply Docker environment changes. The API never exposes `/etc/spartan-cloud/node.env` or the node/Worker shared API secrets.

Do module/theme changes on both nodes when they need matching files. The primary owns application data and SQL; these APIs do not replicate files automatically. Uploads can contain executable PHP, so the master website must enforce appropriate customer permissions.

## Provision, suspend, terminate and resume

The existing `/control/provision` and `/control/lifecycle` APIs remain available. Follow [API.md](API.md) for the full provisioning fields, licence, app key and initial superadmin. Both nodes receive the same tenant ID, fingerprint, app key, URL and primary designation.

To suspend, publish a newer `suspended` routing state, then call `/control/lifecycle` on both nodes:

```json
{"id":"t-111111111111111111111111","fingerprint":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","action":"suspended","lifecycleVersion":1}
```

To terminate, use `action: terminated` and a higher version. Termination removes the container, blocks routing permanently for that ID, and retains the tenant's database, storage and backups. It is not a data-erasure operation. To resume a suspension, call `/control/provision` with the original provisioning fields and a higher version, then publish ready once both nodes succeed. A terminated ID cannot be resumed.
