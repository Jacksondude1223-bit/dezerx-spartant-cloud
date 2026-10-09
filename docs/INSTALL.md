# Node installation

Use the top-level `install.sh` on each Ubuntu or Debian node. Download it while signed in to GitHub and upload it to the node if the repository is private; an anonymous curl request cannot download a private installer itself.

For a private repository:

```bash
sudo bash install.sh us --private
sudo bash install.sh de --private
```

Choose the command for that node's region. Enter a GitHub fine-grained personal access token at the hidden prompt. Limit the token to `Jacksondude1223-bit/dezerx-spartant-cloud` with repository Contents: Read-only. No write permission is needed. Create tokens at https://github.com/settings/personal-access-tokens.

For unattended installation, provide a root-owned token file with mode 600:

```bash
sudo bash install.sh us --github-token-file /root/github-token --env /root/node.env --token /root/tunnel-token --non-interactive
```

`--github-token-file` authenticates the repository download. `--token` remains the Cloudflare Tunnel token file. The installer removes its temporary GitHub credential copy after cloning and on failure. It leaves your original token file untouched. Tokens do not appear in the clone URL, Git configuration, command arguments, or normal installer output.

For public repositories, omit `--private`. If running inside an already downloaded repository, `install.sh` directly invokes the local node installer and does not download again.

Private container images require separate registry authentication before installation, for example `sudo docker login ghcr.io`. Repository access does not grant access to Docker images.

For node installation, copy `node.environment.example` to a private `node.env` file and supply `--env /absolute/path/node.env`. The six entries are the required node settings. Replace the image with your published image digest and provide the existing shared secrets. `NODE_CONTROL_SECRET` must match both nodes and the master website; `ORIGIN_SECRET` must match both nodes and the routing Worker. The installer chooses the region from `us` or `de` and supplies port, storage paths, and resource defaults automatically. Tunnel tokens stay in their separate protected files or hidden prompts.

`environment.example` is for the separate Cloudflare configuration command (`node scripts/configure.mjs`), not the node installer. It keeps the enabled custom hostname and Llama recovery options; default worker names, resource limits, and limits on hostnames or AI calls need no entries. The node example uses default recovery disabled. To enable an already deployed recovery service on a node, add `AI_RECOVERY_ENABLED=true`, `AI_RECOVERY_URL`, and `AI_RECOVERY_SECRET` to its input file.

Both examples use `node-us.dezerx.cloud` and `node-de.dezerx.cloud`. The routing Worker's `US_ORIGIN` and `DE_ORIGIN` must use those same tunnel hostnames when deploying these settings.

Weekly node update checks are installed automatically with the node installer. They run Monday at 09:00 UTC with up to one hour of jitter and catch up after a node was offline. Checks read GitHub metadata and local node files, then save status under `/var/lib/spartan-cloud`; they never install updates or restart services.

For a private repository, configure a separate fine-grained GitHub token with Contents: Read-only for this repository:

```bash
sudo spartan-node-update auth
```

Enter it at the hidden prompt. It is saved as root-only `/etc/spartan-cloud/github-update-token`. The original bootstrap clone token is not retained automatically. Public repository checks work without a token.

Commands available on each node:

```bash
sudo spartan-node-update check
sudo spartan-node-update status
sudo spartan-node-update stage
sudo spartan-node-update apply
```

`stage` downloads node modules, the backup script, and the setup validator from a pinned snapshot of the latest `main` commit, verifies Git blob hashes and JavaScript syntax, and checks compatibility with the existing node environment. It does not run the installer or change the live node. `apply` performs the same preparation, blocks new control jobs, waits for current jobs to complete, and postpones if a backup is running. It replaces only `/opt/spartan-cloud` and restarts only `spartan-agent`. The backup timer is paused during the switch and restored afterward. Failed startup/readiness restores the previous node files and verifies the old agent. Previous releases are retained in `/opt/spartan-cloud-releases`.

Tenant containers, images, databases, volumes, Cloudflare Tunnel, Laravel settings, and encryption keys are not upgraded by this command. Operating system packages, Docker, cloudflared, Worker deployments, installer/systemd changes, and database migrations require their separate update procedures. Only trusted, reviewed repository changes should be applied. Syntax and readiness checks cannot prove all application behavior remains compatible. The agent restart may briefly interrupt routing and disconnect WebSockets; existing containers keep running. Weekly checks have no service restarts.

For an already installed node, install just the check/update tooling from an up-to-date checkout:

```bash
sudo bash scripts/install-node-updates.sh
```

This does not restart the agent or modify tenant data. Older agents without the update guard can check and stage updates, but `apply` refuses replacement. Install the updated agent through the node installer during a maintenance window once to enable safe future updates. If an update command is forcibly killed, inspect the running agent and active jobs before removing `/run/spartan-cloud/node-maintenance`; while the marker remains, new control jobs are refused and tenant traffic is still served.

View the schedule and logs:

```bash
systemctl list-timers spartan-update-check.timer
sudo journalctl -u spartan-update-check.service
```
