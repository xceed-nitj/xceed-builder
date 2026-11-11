#!/usr/bin/env node
// XCEED Dev Workspace builder. One program, two places to run it:
//
//   node run.js --job <id>   GitHub Actions: XCEED started this run for one job.
//   node run.js --poll       A VM: keep asking XCEED for work, forever.
//
// Moving from Actions to a VM changes nothing here: set DEVWS_RUNNER=poll in
// XCEED and start `--poll` on the VM (see vm/setup.sh).
//
// Configuration (environment):
//   XCEED_URL            https://xceed.nitj.ac.in
//   DEVWS_WORKER_SECRET  same value as in XCEED's server/.env
//   ORG_TOKEN            GitHub token that can create org repos, add
//                        collaborators, push branches and open PRs
//   DEVWS_WORKDIR        where jobs work (default: <tmp>/devws)
//   DEVWS_PARALLEL       poll mode: jobs at once (default 2)
//   DEVWS_SLOT           job mode: preview slot to use (default 1)
//
// Nothing here prints build output, paths, names or links: on GitHub Actions
// the builder repo is public and its logs can be read by anyone. Each job's
// log goes to XCEED only.
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createClient } = require("./src/client");
const { api } = require("./src/github");
const { JobLog } = require("./src/log");
const { provision, sync, revoke } = require("./src/workspace");
const { preview } = require("./src/preview");
const { sendPr } = require("./src/pr");
const { Stop } = require("./src/change");

const HEARTBEAT_MS = 30 * 1000;
const POLL_MS = 10 * 1000;
const HANDLERS = { provision, sync, revoke, test: preview, pr: sendPr };

class Cancelled extends Error {}

function config() {
  const c = {
    xceedUrl: process.env.XCEED_URL,
    secret: process.env.DEVWS_WORKER_SECRET,
    token: process.env.ORG_TOKEN,
    workdir: process.env.DEVWS_WORKDIR || path.join(os.tmpdir(), "devws"),
    parallel: Math.max(1, Math.min(4, Number(process.env.DEVWS_PARALLEL) || 2)),
  };
  for (const [k, v] of Object.entries({ XCEED_URL: c.xceedUrl, DEVWS_WORKER_SECRET: c.secret, ORG_TOKEN: c.token })) {
    if (!v) throw new Error(`${k} is not set`);
  }
  return c;
}

// The environment git and other tools get: enough to work, no secrets.
function baseEnv() {
  const keep = ["PATH", "HOME", "LANG", "TMPDIR", "USER"];
  return Object.fromEntries(keep.filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
}

async function runJob({ claimed, client, cfg, slot, runnerId }) {
  const { job, assignment, main } = claimed;
  const dir = path.join(cfg.workdir, `job-${job.id}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(cfg.workdir, 0o700);
  const log = new JobLog(path.join(dir, "job.log"), [cfg.token, cfg.secret, process.env.PREVIEW_SOURCE_MONGO_URL]);

  const ctx = {
    job, assignment, main, dir, log, slot, runnerId,
    token: cfg.token,
    gh: api(cfg.token),
    gitBase: process.env.DEVWS_GIT_BASE || "https://github.com",
    baseEnv: baseEnv(),
    toolsDir: path.join(cfg.workdir, "tools"),
    partial: {},
    cancelled: false,
    checkCancel() {
      if (ctx.cancelled) throw new Cancelled("Stopped");
    },
    async report(patch) {
      Object.assign(ctx.partial, patch);
      await beat();
    },
  };

  async function beat() {
    try {
      const { body } = await client.heartbeat(job.id, log.tail, ctx.partial);
      if (body?.cancel) ctx.cancelled = true;
    } catch {
      /* XCEED briefly unreachable: the next beat will try again */
    }
  }

  const timer = setInterval(beat, HEARTBEAT_MS);
  let outcome;
  try {
    log.line(`Job ${job.type} started on ${runnerId}`);
    outcome = await HANDLERS[job.type](ctx);
  } catch (err) {
    if (err instanceof Stop) outcome = { status: err.status, result: err.result };
    else if (err instanceof Cancelled) outcome = { status: "failed", result: { error: "Stopped before it finished." } };
    else {
      log.line(`Error: ${err.message}`);
      outcome = { status: "failed", result: { error: err.message.slice(0, 500) } };
    }
  } finally {
    clearInterval(timer);
  }

  log.line(`Job ${job.type} ${outcome.status}`);
  try {
    await client.complete(job.id, outcome.status, log.tail, { ...ctx.partial, ...outcome.result });
  } finally {
    log.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return outcome.status;
}

async function jobMode(id) {
  if (!/^[0-9a-f]{24}$/.test(String(id))) throw new Error("Bad job id");
  const cfg = config();
  const runnerId = `actions:${process.env.GITHUB_RUN_ID || crypto.randomBytes(4).toString("hex")}`;
  const client = createClient({ baseUrl: cfg.xceedUrl, secret: cfg.secret, runnerId });
  const res = await client.claim(id);
  if (res.status === 409) return "skipped"; // already taken, done or cancelled
  if (res.status !== 200) throw new Error(`XCEED answered ${res.status}`);
  return runJob({ claimed: res.body, client, cfg, slot: Number(process.env.DEVWS_SLOT) || 1, runnerId });
}

async function pollMode() {
  const cfg = config();
  const runnerId = `vm:${os.hostname()}:${process.pid}`;
  const client = createClient({ baseUrl: cfg.xceedUrl, secret: cfg.secret, runnerId });
  const free = Array.from({ length: cfg.parallel }, (_, i) => i + 1);
  let stopping = false;
  process.on("SIGTERM", () => { stopping = true; });
  process.on("SIGINT", () => { stopping = true; });
  console.log(`Dev Workspace builder polling with ${cfg.parallel} slot(s)`);

  while (!stopping) {
    if (!free.length) {
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    let res;
    try {
      res = await client.claimNext();
    } catch (err) {
      console.error(`Could not reach XCEED: ${err.message}`);
      await new Promise((r) => setTimeout(r, POLL_MS * 3));
      continue;
    }
    if (res.status !== 200) {
      if (res.status !== 204) console.error(`XCEED answered ${res.status}`);
      await new Promise((r) => setTimeout(r, POLL_MS));
      continue;
    }
    const slot = free.shift();
    console.log(`Job ${res.body.job.id} (${res.body.job.type}) in slot ${slot}`);
    runJob({ claimed: res.body, client, cfg, slot, runnerId })
      .then((status) => console.log(`Job ${res.body.job.id} ${status}`))
      .catch((err) => console.error(`Job ${res.body.job.id} could not report: ${err.message}`))
      .finally(() => free.push(slot));
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const main = args[0] === "--job" ? () => jobMode(args[1]) : args[0] === "--poll" ? pollMode : null;
  if (!main) {
    console.error("Usage: node run.js --job <id> | --poll");
    process.exit(2);
  }
  main()
    .then((status) => process.exit(status === "failed" ? 1 : 0))
    .catch(() => {
      // No message: it could contain something private, and this may be a public log.
      process.exit(1);
    });
}

module.exports = { runJob, HANDLERS };
