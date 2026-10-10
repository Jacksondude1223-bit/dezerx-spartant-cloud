# Market cloud module: domain setup before provisioning

The market module owns checkout, payment confirmation and service permissions. After purchase, prepare routing metadata and DNS records before calling the node provisioning API. Preparing a service does not create a Docker container or database.

The records are DNS TXT records, not uploaded text files. Cloudflare hostname ownership and certificate validation are separate checks. Certificate tokens may take time to appear; display the records returned by the API rather than assuming there are always exactly two TXT records.

## Configuration

The Worker requires `ORIGIN_SECRET`, `CF_SAAS_API_TOKEN`, `CLOUDFLARE_ZONE_ID`, `SAAS_CNAME_TARGET` and `ROUTING_WORKER_NAME`. Supply `CF_ROUTING_API_TOKEN` with Zone Workers Routes write permission scoped to the SaaS zone. It creates an exact customer-hostname route after DNS and SSL become active. An existing `CF_INSTANCE_API_TOKEN` or `CF_SAAS_API_TOKEN` can be used instead if it also has Workers Routes write permission. Conflicting routes assigned to another Worker are refused.

New node installations enable `DOMAIN_VERIFICATION_REQUIRED=true`. On existing nodes, add that setting to `/etc/spartan-cloud/node.env` and restart `spartan-agent` after applying the node update. Updates preserve existing configuration, so they do not silently enable the requirement for legacy API clients. If a permit is supplied, nodes validate it even when the legacy compatibility setting is disabled.

## Authentication

Send all three endpoints to `https://load.dezerx.cloud` from the market backend using the existing routing API HMAC headers. Sign the exact JSON bytes with `ROUTING_CONTROL_SECRET` if configured, otherwise `ORIGIN_SECRET`. The canonical message is the millisecond timestamp, HTTP method, pathname and body separated by newlines as specified in `API.md`. Never expose these keys or the provisioning permit to the customer's browser.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/v1/routing/onboarding/prepare` | Reserve the domain and return initial DNS instructions without deploying |
| POST | `/v1/routing/onboarding/status` | Read current instructions and cached domain/SSL state; check the customer route |
| POST | `/v1/routing/onboarding/verify` | Check public DNS, Cloudflare ownership, SSL and the Worker route; issue a permit when ready |

Prepare request:

```json
{
  "id": "t-111111111111111111111111",
  "serviceId": "market_service_1001",
  "customerId": "market_customer_100",
  "primary": "us",
  "hostname": "billing.customer.com"
}
```

Use a stable tenant ID generated once per purchased service. `serviceId` and `customerId` must be stable identifiers containing only letters, digits, underscores and hyphens, up to 100 characters. `primary` is `us` or `de`. Status and verify requests use the same `id`, `serviceId`, `customerId` and `hostname`; `primary` is optional for those two actions. A hostname already reserved for another tenant returns HTTP 409.

The response retains the existing domain fields and adds:

| Field | Module behavior |
| --- | --- |
| `required` | Show the Overview required badge while true |
| `stage` | `spartan_ownership`, `cloudflare_validation`, `routing_setup` or `ready_to_provision` |
| `dnsRecords` | Display every returned record's type, full name and value or target |
| `readyToProvision` | Create is allowed only when true |
| `domainVerificationToken` | Returned by a successful verify only; pass to both nodes from the backend |
| `tokenExpiresAt` | Permit expiry; obtain a fresh permit if deployment retries after expiry |

Example initial response fields:

```json
{
  "required": true,
  "readyToProvision": false,
  "stage": "spartan_ownership",
  "dnsRecords": [
    {
      "type": "CNAME",
      "name": "billing.customer.com",
      "target": "load.dezerx.cloud",
      "proxied": false,
      "purpose": "routing"
    },
    {
      "type": "TXT",
      "name": "_spartan-verification.billing.customer.com",
      "value": "API_GENERATED_TOKEN",
      "purpose": "spartan_ownership"
    }
  ]
}
```

After Spartan ownership is proven, verify registers the Cloudflare custom hostname using TXT certificate validation. Subsequent responses can include `_cf-custom-hostname` ownership records and `_acme-challenge` certificate records with purposes `cloudflare_ownership` and `certificate_validation`. Keep the original records displayed. Preserve the CNAME as DNS-only. Cloudflare may complete certificate validation automatically after the CNAME points to the SaaS target, so show whatever records it actually returns.

## Module sequence

1. Confirm payment and the signed-in customer's permission to manage the purchased service.
2. Call prepare. Mark Overview required and render `dnsRecords`. Do not call `/control/provision` yet.
3. On the customer's Verify action, call verify. HTTP 409 `ownership_not_verified` is a waiting state: keep the instructions and badge visible.
4. When Cloudflare records appear, update the instructions. Poll status for display; call verify periodically with bounded retries to perform fresh checks. Suggested interval is 60 seconds; allow a manual Verify action. DNS propagation, CAA restrictions and Cloudflare certificate delays are not deployment failures.
5. Proceed only after verify returns `readyToProvision=true` and a `domainVerificationToken`. This requires Spartan TXT ownership, an active Cloudflare hostname, an active certificate, the correct CNAME and an exact Worker route to this routing Worker.
6. Send the existing `/control/provision` payload to both nodes. Set `url` to the licensed customer URL and include `domainVerificationToken` unchanged. Use the same ID, APP_KEY, fingerprint, primary, license and lifecycle version on both nodes. Include `initialAdmin` only on the primary. The permit lasts ten minutes and is bound to the tenant and hostname. It does not replace the request HMAC signature.
7. Wait for both nodes to return `ready`; a node returning `provisioning` is still waiting. Retry idempotently with the same service data and a fresh verification permit when needed. Never generate another APP_KEY or recreate the service identity on retry.
8. Publish `/v1/routing/instances` with `status=ready` and `lifecycleVersion=1` for a newly prepared service. Prepare created its pending routing metadata at version 0; the transition to ready requires a greater version. For an existing service, increase its current version instead.
9. Remove the required badge and show the live URL after provisioning completes. Track deployment state separately from domain readiness: DNS can be ready while the image, license, database or administrator setup still fails.

Include this extra field in the existing node provisioning request:

```json
{
  "domainVerificationToken": "TOKEN_RETURNED_BY_VERIFY"
}
```

Nodes return HTTP 409 `domain_verification_required` for a missing, expired, altered or wrong-domain permit when enforcement is enabled. The existing `/control/domain` API also accepts `domainVerificationToken` for a newly verified domain.

No customer password or license is needed to prepare or verify DNS. Keep those values on the market backend until provisioning. Domain permits are not persisted in node tenant state. The existing encryption key, database and storage remain part of the service's stable provisioning data.

## Retry and errors

HTTP 400 means invalid input. HTTP 401 means the backend HMAC authentication failed. HTTP 409 means ownership is still unverified, the service identity conflicts, the service is suspended/terminated or a quota has been reached; inspect `error` and any returned domain instructions. HTTP 503 means a provider/configuration request failed. For customer-route errors, check Workers Routes token permissions and the exact route's assigned Worker. Do not call create in response to an error or a missing permit.

An interrupted Cloudflare hostname creation holds a five-minute lease before another create attempt is allowed. Retries first look up the hostname remotely to recover a creation that succeeded despite a lost response.

Status reads cached DNS/certificate state; verify performs fresh checks. The Worker cron also refreshes certificate state. Customer routes created during verification are preserved by `npm run deploy` using active domains recorded in D1.

DNS verification prevents premature provisioning but does not guarantee deployment success. Vendor license validity, image registry access and available resources must still be checked and failed deployments retried or escalated without deleting existing tenant data.
