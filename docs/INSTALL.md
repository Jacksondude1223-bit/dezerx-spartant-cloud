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
