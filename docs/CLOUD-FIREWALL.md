# Spartan Cloud Firewall

Open **Cloud Firewall** in the Cloudflare-hosted dashboard to manage Contabo network firewalls. The integration uses the official API at https://api.contabo.com/. Management requires a dashboard operator session.

## Connect Contabo

Configure these runtime settings under **Cloudflare → Workers & Pages → dashboard Worker → Settings → Variables and Secrets**. Use the types below, save and deploy the changes, then refresh Cloud Firewall. The username and client ID are already included in `dashboard-worker/wrangler.toml` so repository deployments retain them.

| Setting | Type | Value |
| --- | --- | --- |
| `CONTABO_CLIENT_ID` | Text | Client ID from Contabo Security & Access |
| `CONTABO_CLIENT_SECRET` | Secret | Complete client secret, not its masked display |
| `CONTABO_API_USERNAME` | Text | Contabo API user's email address |
| `CONTABO_API_PASSWORD` | Secret | Separate password created for that API user |

Set the API-user password through Contabo's Security & Access password email. It is distinct from the client secret. The integration does not create users or regenerate credentials. These secrets are independent of the node API keys and `DASHBOARD_DATA_KEY`.

Authentication guide: https://help.contabo.com/en/support/solutions/articles/103000270527-how-can-i-access-the-contabo-api-

## Manage firewalls

The dashboard lists firewall status, inbound accept rules and assigned instances. Create a firewall and configure TCP, UDP, ICMP or all-protocol rules. Sources support IPv4/IPv6 addresses, CIDRs, `AnyIPv4` and `AnyIPv6`. TCP and UDP support single ports, comma-separated ports or ranges; empty ports mean any port. ICMP and all-protocol rules have no ports.

New firewalls start **inactive and unassigned**. Rule additions, edits and removals stay in a draft until **Save rule changes** is confirmed. Saved rules replace the complete inbound list. Activate/deactivate a firewall, assign/detach instances, or rename it from its detail page. Delete only after every instance is detached.

An active firewall drops inbound traffic not accepted by an active rule. Outbound traffic remains unrestricted. Before activation or assignment, review SSH access and peer UDP 51820 rules for the Spartan US/Germany database VPN. Cloudflare Tunnel uses outbound connections. The dashboard does not create public node web ports or expose MariaDB.

The integration does not automatically buy add-ons or alter instance products. If Contabo reports an add-on requirement or an unsupported instance, the dashboard displays the error. Eligibility and pricing are controlled by Contabo.

## Dashboard API

All routes require a session. POST also requires its `X-CSRF-Token`. Credentials are never returned to the browser. Mutation bodies need `confirmed: true`; existing-firewall mutations also need `version` from the latest detail response.

| Method | Path | Purpose / input |
| --- | --- | --- |
| GET | `/api/firewall/config` | Configuration status and missing secret names |
| GET | `/api/firewall` | Firewalls and instance selection list |
| GET | `/api/firewall/{firewallId}` | Details and current `version` |
| POST | `/api/firewall/create` | `name`, optional `description`, optional `rules` array; always inactive |
| POST | `/api/firewall/{firewallId}/update` | `name`, `description`, `status` (`active`/`inactive`), `version` |
| POST | `/api/firewall/{firewallId}/rules` | Complete `rules` array, `version` |
| POST | `/api/firewall/{firewallId}/attach` | Numeric `instanceId`, `version` |
| POST | `/api/firewall/{firewallId}/detach` | Numeric `instanceId`, `version` |
| POST | `/api/firewall/{firewallId}/delete` | `version`; no instances may remain attached |

Example rule:

```json
{
  "displayName": "Peer database VPN",
  "protocol": "udp",
  "destPorts": ["51820"],
  "srcCidr": {"ipv4": ["198.51.100.5/32"], "ipv6": []},
  "action": "accept",
  "status": "active"
}
```

Requests use fixed Contabo HTTPS API and OAuth endpoints, refuse redirects and time out after 20 seconds per upstream request. Access tokens are cached only in Worker memory. Credential changes invalidate the cache. Only rejected access tokens trigger one reauthentication retry; ambiguous failures are not automatically retried.

The dashboard D1 database holds audit events and per-firewall leases in existing tables. It stores no Contabo credentials or OAuth tokens. Version checks prevent overwriting an already observed change; Contabo does not expose transactional compare-and-set for simultaneous external edits. After a timeout, refresh provider state before retrying.

This feature needs no routing D1 changes, node reinstall, container recreation or encryption-key changes. The optional node-hosted dashboard does not expose Contabo management.
