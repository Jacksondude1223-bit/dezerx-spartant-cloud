# Routing Worker deployment

Cloudflare Workers Builds settings:

| Setting | Value |
| --- | --- |
| Root directory | `workers` |
| Build command | Leave empty |
| Deploy command | `npm run deploy` |

The deploy command runs `workers/deploy.mjs`. It applies pending numbered SQL files from `workers/migrations` to the remote `DB` binding, checks every migration is recorded in `d1_migrations`, and verifies the application's required column types, nullability, primary keys, defaults, and indexes. It uploads the Worker only after those checks succeed. Schema or permissions errors fail the build before upload. No tenant data is read by the verification query.

The Cloudflare Builds API token must have Account D1 Edit permission for the account owning this database, along with the permissions needed to deploy the Worker. A runtime D1 binding alone does not grant the build token permission to execute migrations.

For local deployment:

```bash
cd workers
npm install
npm run deploy
```

For a read-only schema and migration check:

```bash
npm run db:verify
```

The repository-level `scripts/deploy.sh` also uses this deployment check. A direct `npx wrangler deploy`, dashboard editor upload, or preview command bypasses it. Cloudflare Builds does not honor Wrangler custom-build configuration, so the explicit deploy command is required.

`0001_routing.sql` creates the current routing schema with `IF NOT EXISTS`; existing compatible databases retain their rows and gain migration tracking. An incompatible pre-existing schema fails verification rather than silently deleting or rebuilding tables. Add forward-compatible changes as new numbered migrations, update the verification requirements, and test them before deployment. Do not edit migrations that have already been applied. Database changes must remain compatible with the currently deployed Worker because they run before the new Worker upload.
