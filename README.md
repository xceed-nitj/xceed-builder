# XCEED Dev Workspace builder

Does the work XCEED itself never does: creates each developer's small private
repo, builds previews of the full site for the **Test** button, opens pull
requests for **Send PR**, and removes access when an assignment ends.

XCEED keeps a queue of jobs (`server/src/modules/devWorkspaceModule`). This
program takes one job at a time, does it, and reports back over HTTPS, signed
with `DEVWS_WORKER_SECRET`.

| Job | What it does |
|---|---|
| provision | Creates `org/ws-<github user>-<id>` (private) with only the assigned files at their usual paths, plus `WORKSPACE.md`, and invites the developer |
| sync | Updates the workspace's `main` with the latest versions of the assigned files |
| test | Checks the branch, applies it on the latest main, builds the site, starts it with made-up data and gives back a private link and test logins. Stops after 15 minutes idle or 60 minutes |
| pr | Checks the branch, applies it on the latest main, pushes a branch to the main repo and opens the PR with the "what to check in production" list |
| revoke | Removes the developer and any open invitation, archives the repo |

Before every test and PR: changes outside the writable files are **rejected**,
and code that reads files, runs commands, reads secrets, calls the network or
pulls other files into the bundle is **held** until an admin approves it in XCEED.

## Where it runs

The same `run.js` runs in both places. Switching is configuration only.

### Now: GitHub Actions (free, no VM)

1. Create a **public** repo `xceed-builder` in the organisation. Give no
   developer write access. In *Settings → Actions → General*, set fork pull
   request workflows to require approval for all outside collaborators.
2. Copy this folder's contents to the root of that repo (including
   `.github/workflows/job.yml`) and push.
3. *Settings → Secrets and variables → Actions*, add:
   - `XCEED_URL` = `https://xceed.nitj.ac.in`
   - `DEVWS_WORKER_SECRET` = a long random value (`openssl rand -hex 32`)
   - `ORG_TOKEN` = the organisation token (create repos, manage collaborators,
     push branches, open PRs on the main repo)
   - `PREVIEW_SOURCE_MONGO_URL` (optional) = the **test** database's address,
     the same `MONGO_URL` a local `server/.env` uses. Every preview gets its
     own copy of it; the builder only reads from it (mongodump) and developer
     code never sees the address. In Atlas Network Access allow access from
     anywhere (0.0.0.0/0), because GitHub's machines have no fixed address.
     Never the production cluster.
   - `PREVIEW_SOURCE_EXCLUDE` (optional, usually not needed) = more
     collections to skip, comma-separated. Sign-in sessions, one-time codes,
     reset links, push tokens, camera stream addresses, the mail queue and
     metrics are always skipped (`DEFAULT_EXCLUDE` in `src/preview.js`).
4. Create a second, fine-grained token with access to **only** `xceed-builder`
   and permission *Actions: read and write*. This one goes into XCEED.
5. In XCEED's `server/.env`, then Pull & Deploy:
   ```
   DEVWS_WORKER_SECRET=<same value as step 3>
   DEVWS_GITHUB_TOKEN=<token from step 4>
   ```
6. In XCEED, Super Admin → Dev Workspace → Settings: switch it on, choose
   GitHub Actions, check the builder repo name, save.

Because the repo is public, its run logs are public. The workflow therefore
throws away all output and shows only "job finished"; the real log goes to
XCEED. `server/tests/unit/devwsBuilderWorkflow.test.js` in the XCEED repo
fails if the workflow gains a trigger, an input, a step, an artifact or a cache.
To make the repo private later, flip it in GitHub; nothing else changes (it
then uses the free 2,000 Actions minutes a month).

### Later: any VM (Oracle, a college machine)

On an Ubuntu VM with 4 cores and 8 GB or more:

```bash
git clone <this repo> && cd xceed-builder
sudo bash vm/setup.sh
sudo nano /etc/devws-builder.env
sudo systemctl enable --now devws-builder
```

Then in XCEED, Super Admin → Dev Workspace → Settings, choose "A VM" and
save. `DEVWS_GITHUB_TOKEN` is no longer needed. The VM needs no open ports: it only
makes outgoing connections to XCEED, GitHub and Cloudflare.

## Running by hand

```bash
XCEED_URL=... DEVWS_WORKER_SECRET=... ORG_TOKEN=... node run.js --job <id>
XCEED_URL=... DEVWS_WORKER_SECRET=... ORG_TOKEN=... node run.js --poll
```

`DEVWS_GIT_BASE=file:///path/to/bare/repos` points git at local repos instead
of GitHub; the XCEED tests use it.

## What a preview can and cannot do

- Built and run as a separate account (`xpreview1`…) with an empty
  environment: it never sees the tokens.
- After installing dependencies, that account can reach nothing but this
  machine, so the preview's server cannot send anything anywhere.
- Its database is a throwaway MongoDB: a copy of the test database when
  `PREVIEW_SOURCE_MONGO_URL` is set, plus the preview logins from
  `server/scripts/seedPreview.js`. The preview never connects to the shared
  database itself, so nothing a developer does can change it. If the copy
  fails, the preview still starts with the logins only and says so.
- The client is built with `VITE_PREVIEW=1`, so it talks to its own server and
  never to production. No source maps. The notebook runtimes are not
  downloaded, so notebooks do not run in previews.
- The ML service is not part of previews.
