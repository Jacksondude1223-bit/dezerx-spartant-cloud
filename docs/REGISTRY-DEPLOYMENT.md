# Configure private registry access on both nodes

The manually triggered `Configure node registry access` workflow sends the GHCR token over authenticated SSH to `docker login --password-stdin` on both nodes, then pulls the selected image by digest. It runs only from `main`. It does not install the node, deploy an application container, change the configured image, restart services, or run database migrations. Docker saves credentials under `/etc/spartan-cloud/docker`, with a root-only directory. The agent uses that configuration because its `ProtectHome=true` sandbox hides `/root/.docker`. An existing installed agent needs a systemd drop-in setting `Environment=DOCKER_CONFIG=/etc/spartan-cloud/docker` and an agent restart; the code updater does not rewrite the service unit. The token never goes into tenant environments or source files.

In repository Settings > Secrets and variables > Actions, add these repository secrets:

| Secret | Value |
| --- | --- |
| `GHCR_TOKEN` | Classic GitHub token with `read:packages`, owned by an account granted access to the image |
| `NODE_SSH_PRIVATE_KEY` | Dedicated SSH private key whose public key is authorized on both nodes; use an unencrypted key for noninteractive automation |
| `NODE_SSH_KNOWN_HOSTS` | Verified SSH known_hosts entries for both nodes |
| `US_SSH_HOST` | Reachable US SSH address or IP |
| `US_SSH_USER` | US SSH login user |
| `DE_SSH_HOST` | Reachable Germany SSH address or IP |
| `DE_SSH_USER` | Germany SSH login user |

Optional repository variables:

| Variable | Default |
| --- | --- |
| `GHCR_USERNAME` | `Jacksondude1223-bit` |
| `US_SSH_PORT` | `22` |
| `DE_SSH_PORT` | `22` |

The SSH login user must be able to run the workflow's root shell command with `sudo -n`; root login works on systems where sudo is installed. Docker must already be installed. For SSH port 22, each known_hosts line has the form `SSH_ADDRESS ssh-ed25519 PUBLIC_HOST_KEY`. For another port use `[SSH_ADDRESS]:PORT ssh-ed25519 PUBLIC_HOST_KEY`. Verify the host keys using a trusted server console or existing trusted SSH connection. The workflow refuses unknown or changed host keys; it does not automatically trust keys discovered over the network.

The GitHub-hosted runner needs network access to both SSH endpoints. The existing HTTP tunnel on port 8788 does not provide SSH access. Do not use the HTTP-only node tunnel hostnames as SSH endpoints. If your home node has no reachable SSH endpoint, this workflow cannot reach it; use a separately configured SSH access path or an outbound self-hosted runner setup instead.

After saving the secrets, open Actions > Configure node registry access > Run workflow, select `main`, confirm the image digest, and run. Both node jobs must succeed. Re-run to rotate the registry credentials. This workflow stores credentials and pulls the image; to install a fresh node, run the node installer afterward. To upgrade existing tenant containers, use the existing tenant upgrade procedure rather than restarting or recreating them here.
