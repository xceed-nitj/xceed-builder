// Test: the full site, built from the latest main plus the developer's
// change, running with a database of made-up data, reachable at a private
// https link for up to an hour.
//
// What keeps it contained:
//   - Built and run as a separate unix account (xpreview<slot>) with an empty
//     environment: the org token and the XCEED secret never reach it.
//   - Once dependencies are installed, that account's outgoing traffic is
//     blocked except to this machine (iptables owner match). The preview's
//     server cannot call out; only the tunnel (run by the builder) can.
//   - Its database is a throwaway MongoDB container filled by
//     server/scripts/seedPreview.js. No real .env, no real data.
//   - The client is built with VITE_PREVIEW=1 so it calls its own server,
//     never production, and without source maps.
// Same code on GitHub Actions and on a VM.
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const { run, start, stop } = require("./exec");
const { prepareChange } = require("./change");

const IDLE_MS = 15 * 60 * 1000;
const MAX_MS = 60 * 60 * 1000;
const BOOT_MS = 3 * 60 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function portsFor(slot) {
  return { app: 18000 + slot * 10, proxy: 18001 + slot * 10, mongo: 27100 + slot };
}

async function ensureUser(ctx, user) {
  const exists = await run("id", ["-u", user], { check: false, log: ctx.log });
  if (exists.code === 0) return;
  await run("sudo", ["-n", "useradd", "--system", "--create-home", "--shell", "/usr/sbin/nologin", user], { log: ctx.log });
}

function firewallArgs(user) {
  return [
    ["OUTPUT", "-m", "owner", "--uid-owner", user, "-o", "lo", "-j", "ACCEPT"],
    ["OUTPUT", "-m", "owner", "--uid-owner", user, "-j", "REJECT"],
  ];
}

async function blockNetwork(ctx, user) {
  for (const tool of ["iptables", "ip6tables"]) {
    // Inserted in reverse so ACCEPT on loopback ends up above the REJECT.
    for (const rule of [...firewallArgs(user)].reverse()) {
      await run("sudo", ["-n", tool, "-I", rule[0], "1", ...rule.slice(1)], { log: ctx.log });
    }
  }
}

async function unblockNetwork(ctx, user) {
  for (const tool of ["iptables", "ip6tables"]) {
    for (const rule of firewallArgs(user)) {
      // Repeat until gone, in case an earlier run left a copy behind.
      for (let i = 0; i < 5; i += 1) {
        const r = await run("sudo", ["-n", tool, "-D", ...rule], { log: ctx.log, check: false });
        if (r.code !== 0) break;
      }
    }
  }
}

async function cloudflaredBinary(ctx) {
  const onPath = await run("cloudflared", ["--version"], { check: false, log: ctx.log }).catch(() => ({ code: 1 }));
  if (onPath.code === 0) return "cloudflared";
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  const file = path.join(ctx.toolsDir, `cloudflared-${arch}`);
  if (!fs.existsSync(file)) {
    ctx.log.line("Downloading cloudflared");
    const res = await fetch(`https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}`);
    if (!res.ok) throw new Error(`Could not download cloudflared: ${res.status}`);
    fs.mkdirSync(ctx.toolsDir, { recursive: true });
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()), { mode: 0o755 });
  }
  return file;
}

/** A tiny reverse proxy in front of the preview: it knows when the developer last used it. */
function startProxy(appPort, proxyPort, onUse) {
  const server = http.createServer((req, res) => {
    onUse();
    const upstream = http.request(
      { host: "127.0.0.1", port: appPort, method: req.method, path: req.url, headers: req.headers },
      (up) => {
        res.writeHead(up.statusCode || 502, { ...up.headers, "x-robots-tag": "noindex, nofollow" });
        up.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end("The preview is starting or has stopped.");
    });
    req.pipe(upstream);
  });
  server.on("upgrade", (req, socket, head) => {
    onUse();
    const up = net.connect(appPort, "127.0.0.1", () => {
      const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      up.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head?.length) up.write(head);
      socket.pipe(up).pipe(socket);
    });
    up.on("error", () => socket.destroy());
    socket.on("error", () => up.destroy());
  });
  server.listen(proxyPort, "127.0.0.1");
  return server;
}

async function waitFor(check, timeoutMs, stepMs = 2000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return true;
    await sleep(stepMs);
  }
  return false;
}

function httpOk(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/", timeout: 3000 }, (res) => {
      res.resume();
      resolve(res.statusCode && res.statusCode < 500);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

/**
 * How to copy the shared test database into the preview's own database:
 * mongodump from PREVIEW_SOURCE_MONGO_URL, piped straight into mongorestore
 * in the preview's container, renamed to xceed_preview. A copy, never a live
 * connection: developer code can then change nothing in the shared database,
 * and the preview's blocked network does not matter.
 *
 * The builder only reads from it (mongodump), and the address never reaches
 * the preview account or developer code. Never point it at production.
 */
// Never copied, whatever else is: live sign-in material (sessions, one-time
// codes, reset links, push tokens), camera stream addresses (they carry the
// camera's own login), the mail queue, and metrics nobody needs in a preview.
// Picked from the test database on 11 Nov 2026 (23.6 MB, 348 collections), so
// size is not the reason for any of them. PREVIEW_SOURCE_EXCLUDE adds to this.
const DEFAULT_EXCLUDE = [
  "sessions", "otps", "helpdesk_otps", "lm_leave_otps", "lm_co_teacher_otps",
  "photoupdatetokens", "resetpasswords", "captchaverifications", "loginhistories", "lm_fcm_tokens",
  "cameras", "recording_schedules", "recordingschedules",
  "mailoutboxes", "gpumetrics", "server_load_history", "server_process_metrics",
];

function sourcePlan(url, excludeCsv = "") {
  const m = String(url || "").match(/^mongodb(?:\+srv)?:\/\/[^/]+\/?([^?]*)/);
  if (!m) throw new Error("PREVIEW_SOURCE_MONGO_URL is not a mongodb:// or mongodb+srv:// address");
  const db = m[1] || "test";
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(db)) throw new Error("Unexpected database name in PREVIEW_SOURCE_MONGO_URL");
  const extra = String(excludeCsv || "").split(",").map((s) => s.trim()).filter((s) => /^[A-Za-z0-9_.-]{1,120}$/.test(s));
  const excludes = [...new Set([...DEFAULT_EXCLUDE, ...extra])];
  return {
    db,
    dumpArgs: [
      "run", "--rm", "-i", "-e", "SRC_URI", "mongo:7", "sh", "-c",
      'exec mongodump --uri="$SRC_URI" --archive --gzip --quiet --readPreference=secondaryPreferred "$@"',
      // mongodump has no --nsExclude (that is mongorestore's); it takes
      // --excludeCollection, which needs --db.
      // 300+ small collections, each a few round trips to Atlas: read many at
      // once, or the far-away round trips add up to minutes.
      "dump", `--db=${db}`, "--numParallelCollections=16", ...excludes.map((c) => `--excludeCollection=${c}`),
    ],
    restoreArgs: (container) => [
      "exec", "-i", container, "mongorestore", "--archive", "--gzip", "--drop", "--quiet",
      `--nsFrom=${db}.*`, "--nsTo=xceed_preview.*",
    ],
  };
}

/** Streams the dump into the restore. Resolves with nothing; throws with the reason. */
function copySourceDb(ctx, container, url, excludeCsv) {
  const { spawn } = require("child_process");
  const plan = sourcePlan(url, excludeCsv);
  return new Promise((resolve, reject) => {
    const dump = spawn("docker", plan.dumpArgs, { env: { PATH: process.env.PATH, HOME: os.homedir(), SRC_URI: url }, stdio: ["ignore", "pipe", "pipe"] });
    const restore = spawn("docker", plan.restoreArgs(container), { env: { PATH: process.env.PATH, HOME: os.homedir() }, stdio: ["pipe", "pipe", "pipe"] });
    dump.stderr.on("data", (d) => ctx.log.write(d.toString()));
    restore.stdout.on("data", (d) => ctx.log.write(d.toString()));
    restore.stderr.on("data", (d) => ctx.log.write(d.toString()));
    dump.stdout.pipe(restore.stdin);
    const timer = setTimeout(() => { dump.kill("SIGKILL"); restore.kill("SIGKILL"); }, 15 * 60 * 1000);
    let dumpCode = null;
    dump.on("close", (code) => { dumpCode = code; });
    dump.on("error", reject);
    restore.on("error", reject);
    restore.on("close", (code) => {
      clearTimeout(timer);
      if (dumpCode !== 0) return reject(new Error(`could not read the test database (mongodump exit ${dumpCode})`));
      if (code !== 0) return reject(new Error(`could not load the copy (mongorestore exit ${code})`));
      return resolve();
    });
  });
}

async function preview(ctx) {
  const { branch } = ctx.job.payload;
  const { mainDir, changedFiles } = await prepareChange(ctx, { branch });

  const user = `xpreview${ctx.slot}`;
  const ports = portsFor(ctx.slot);
  const appDir = path.join(os.tmpdir(), `devws-preview-${ctx.slot}`);
  const mongoName = `devws-mongo-${ctx.slot}`;
  const userEnv = {
    PATH: process.env.PATH,
    HOME: `/home/${user}`,
    PUPPETEER_SKIP_DOWNLOAD: "1",
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD: "1",
    CI: "1",
  };
  const asUser = (cmd, args, cwd, extraEnv = {}, opts = {}) =>
    run(cmd, args, { cwd, env: { ...userEnv, ...extraEnv }, asUser: user, log: ctx.log, timeoutMs: 20 * 60 * 1000, ...opts });

  let server = null;
  let tunnel = null;
  let proxy = null;
  let lastUse = Date.now();
  const startedAt = Date.now();

  const cleanup = async () => {
    stop(tunnel);
    stop(server);
    if (proxy) proxy.close();
    await run("sudo", ["-n", "pkill", "-KILL", "-u", user], { check: false, log: ctx.log });
    await run("docker", ["rm", "-f", mongoName], { check: false, log: ctx.log });
    await unblockNetwork(ctx, user);
    await run("sudo", ["-n", "rm", "-rf", appDir], { check: false, log: ctx.log });
  };

  try {
    await ensureUser(ctx, user);
    await cleanup(); // anything an earlier crashed run left in this slot

    ctx.log.line("Preparing the preview copy");
    fs.cpSync(mainDir, appDir, { recursive: true, filter: (p) => path.basename(p) !== ".git" });
    await run("sudo", ["-n", "chown", "-R", `${user}:`, appDir], { log: ctx.log });
    await ctx.report({ phase: "building", changedFiles });

    ctx.log.line("Installing server dependencies");
    await asUser("yarn", ["install", "--frozen-lockfile", "--non-interactive", "--network-timeout", "600000"], path.join(appDir, "server"));
    ctx.checkCancel();
    ctx.log.line("Installing client dependencies");
    await asUser("yarn", ["install", "--frozen-lockfile", "--non-interactive", "--network-timeout", "600000"], path.join(appDir, "client"));
    ctx.checkCancel();
    ctx.log.line("Building the client (no notebook runtimes, no source maps)");
    await asUser("node", ["node_modules/vite/bin/vite.js", "build"], path.join(appDir, "client"), { VITE_PREVIEW: "1", NODE_ENV: "production" });
    ctx.checkCancel();

    // From here on the preview account can reach nothing but this machine.
    await blockNetwork(ctx, user);

    ctx.log.line("Starting a throwaway database");
    await run("docker", ["run", "-d", "--rm", "--name", mongoName, "-p", `127.0.0.1:${ports.mongo}:27017`, "mongo:7"], { log: ctx.log });
    const mongoUrl = `mongodb://127.0.0.1:${ports.mongo}/xceed_preview`;
    const mongoUp = await waitFor(async () => {
      const r = await run("docker", ["exec", mongoName, "mongosh", "--quiet", "--eval", "db.runCommand({ping:1}).ok"], { check: false, log: ctx.log });
      return r.code === 0;
    }, 90000);
    if (!mongoUp) throw new Error("The preview database did not start");

    // A copy of the shared test database, when one is configured. Done while
    // the preview account runs nothing (pkill below), since the address is
    // briefly on a command line inside the dump container.
    let dataSource = "made-up logins only";
    const sourceUrl = process.env.PREVIEW_SOURCE_MONGO_URL;
    if (sourceUrl) {
      await run("sudo", ["-n", "pkill", "-KILL", "-u", user], { check: false, log: ctx.log });
      ctx.log.line("Copying the test database");
      try {
        const copyStart = Date.now();
        await copySourceDb(ctx, mongoName, sourceUrl, process.env.PREVIEW_SOURCE_EXCLUDE);
        ctx.log.line(`Copied the test database in ${Math.round((Date.now() - copyStart) / 1000)}s`);
        dataSource = "copy of the test database";
      } catch (err) {
        // Still useful without it: the made-up logins below always work.
        ctx.log.line(`Test database copy failed: ${err.message}. Continuing with made-up logins only.`);
        dataSource = `made-up logins only (test database copy failed: ${err.message})`;
      }
    }
    ctx.checkCancel();

    ctx.log.line("Adding the preview logins");
    const seeded = await asUser("node", ["scripts/seedPreview.js"], path.join(appDir, "server"), { PREVIEW_MODE: "1", MONGO_URL: mongoUrl });
    const lastLine = seeded.stdout.trim().split("\n").pop();
    const { logins } = JSON.parse(lastLine);

    ctx.log.line("Starting the site");
    let exited = null;
    server = start("node", ["src/index.js"], {
      cwd: path.join(appDir, "server"),
      asUser: user,
      log: ctx.log,
      env: {
        ...userEnv,
        NODE_ENV: "production",
        PORT: String(ports.app),
        LISTEN_HOST: "127.0.0.1",
        MONGO_URL: mongoUrl,
        JWT_SECRET: crypto.randomBytes(32).toString("hex"),
        // Answers requests and runs no scheduled job, mail or worker.
        SERVER_ROLE: "quiz",
        PREVIEW_MODE: "1",
        DEPLOY_ENABLED: "false",
        DEVWS_ENABLED: "false",
      },
    });
    server.on("exit", (code) => { exited = code; });
    const up = await waitFor(async () => exited === null && httpOk(ports.app), BOOT_MS);
    if (!up) throw new Error(exited !== null ? `The site stopped while starting (exit ${exited}). See the log.` : "The site did not start within 3 minutes");

    proxy = startProxy(ports.app, ports.proxy, () => { lastUse = Date.now(); });

    ctx.log.line("Opening a private link");
    const bin = await cloudflaredBinary(ctx);
    let url = null;
    tunnel = start(bin, ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${ports.proxy}`], {
      log: ctx.log,
      env: { PATH: process.env.PATH, HOME: os.homedir() },
      onOutput: (text) => {
        const m = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (m && !url) url = m[0];
      },
    });
    if (!(await waitFor(async () => Boolean(url), 60000, 1000))) throw new Error("Could not open a link for the preview");
    // The link takes a few seconds to start answering.
    await sleep(5000);

    lastUse = Date.now();
    await ctx.report({ phase: "live", previewUrl: url, logins, changedFiles, dataSource });
    ctx.log.line("Preview is live");

    let reason = "";
    for (;;) {
      await sleep(10000);
      if (ctx.cancelled) reason = "stopped";
      else if (exited !== null) reason = "crashed";
      else if (Date.now() - lastUse > IDLE_MS) reason = "idle";
      else if (Date.now() - startedAt > MAX_MS) reason = "time limit";
      if (reason) break;
    }
    ctx.log.line(`Preview ended (${reason})`);
    if (reason === "crashed") {
      return { status: "failed", result: { phase: "stopped", error: `The site stopped (exit ${exited}). See the log.`, previewUrl: "" } };
    }
    return { status: "done", result: { phase: "stopped", previewUrl: "", error: "" } };
  } finally {
    await cleanup();
  }
}

module.exports = { preview, startProxy, portsFor, firewallArgs, sourcePlan, copySourceDb, DEFAULT_EXCLUDE };
