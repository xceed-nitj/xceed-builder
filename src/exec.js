// Running commands. Never through a shell: every argument is passed as-is, so
// a branch name or a path from XCEED can never become a command.
const { spawn } = require("child_process");

const CAPTURE_MAX = 4 * 1024 * 1024;

/**
 * Runs `cmd args`, streaming its output into the job log.
 * Resolves { code, stdout, stderr }; rejects only when `check` is set and the
 * exit code is not 0.
 *
 * `asUser` runs it as another unix account through sudo, with ONLY the given
 * environment (env -i): the builder's own variables (tokens) never reach it.
 */
function run(cmd, args, { cwd, env, log, timeoutMs = 20 * 60 * 1000, check = true, asUser, input } = {}) {
  let file = cmd;
  let argv = args;
  let childEnv = env || process.env;
  if (asUser) {
    const pairs = Object.entries(env || {}).map(([k, v]) => `${k}=${v}`);
    file = "sudo";
    argv = ["-n", "-u", asUser, "-H", "env", "-i", ...pairs, cmd, ...args];
    childEnv = { PATH: process.env.PATH };
  }
  return new Promise((resolve, reject) => {
    const child = spawn(file, argv, { cwd, env: childEnv, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d) => {
      if (stdout.length < CAPTURE_MAX) stdout += d;
      log?.write(d.toString());
    });
    child.stderr.on("data", (d) => {
      if (stderr.length < CAPTURE_MAX) stderr += d;
      log?.write(d.toString());
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (check && code !== 0) {
        // The last stderr line is what actually went wrong; without it the
        // developer's page only says "exited with 1".
        const tail = stderr.trim().split("\n").pop().slice(0, 300);
        const err = new Error(`${cmd} ${args[0] || ""} exited with ${code}${tail ? `: ${tail}` : ""}`);
        err.code = code;
        err.stdout = stdout;
        err.stderr = stderr;
        return reject(err);
      }
      return resolve({ code, stdout, stderr });
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

/**
 * Starts a long-lived process (the preview server, cloudflared). Output goes to
 * the log. Returns the child; the caller stops it.
 */
function start(cmd, args, { cwd, env, log, asUser, onOutput } = {}) {
  let file = cmd;
  let argv = args;
  let childEnv = env || process.env;
  if (asUser) {
    const pairs = Object.entries(env || {}).map(([k, v]) => `${k}=${v}`);
    file = "sudo";
    argv = ["-n", "-u", asUser, "-H", "env", "-i", ...pairs, cmd, ...args];
    childEnv = { PATH: process.env.PATH };
  }
  const child = spawn(file, argv, { cwd, env: childEnv, stdio: ["ignore", "pipe", "pipe"], detached: true });
  const onData = (d) => {
    log?.write(d.toString());
    onOutput?.(d.toString());
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  return child;
}

/** Kills a started process and everything it started. */
function stop(child) {
  if (!child || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try { child.kill("SIGTERM"); } catch { /* already gone */ }
  }
  setTimeout(() => {
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ }
  }, 5000).unref();
}

module.exports = { run, start, stop };
