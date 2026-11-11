// Turning a developer's branch into a change on top of the latest main, for
// both Test and Send PR.
//
// 1. Find the base: the newest commit the BUILDER made on the workspace repo
//    (its creation or a sync) that the branch contains. XCEED keeps the list
//    of those commits, so editing anything in the workspace repo cannot fake it.
// 2. Diff base..branch. Every changed file must be writable (validate.js).
// 3. Scan the added lines; flagged code is held unless an admin approved it.
// 4. Apply the diff to a fresh checkout of main with a three-way merge, using
//    the main commit that base mirrors, so newer changes on main are kept and
//    a real conflict is reported instead of overwritten.
const fs = require("fs");
const path = require("path");
const { git, cloneMain, repoUrl } = require("./workspace");
const { checkChangedFiles, scanPatch, parseRawDiff, META_FILES } = require("./validate");

const MAX_PATCH_BYTES = 5 * 1024 * 1024;
const EXCLUDE = META_FILES.map((f) => `:(exclude)${f}`);

class Stop extends Error {
  constructor(status, result) {
    super(result.error || status);
    this.status = status;
    this.result = result;
  }
}

async function prepareChange(ctx, { branch }) {
  const a = ctx.assignment;
  const wsDir = path.join(ctx.dir, "ws");
  const mainDir = path.join(ctx.dir, "main");

  ctx.log.line(`Reading branch ${branch} of ${a.repoName}`);
  await git(ctx, ["clone", "-q", "--no-tags", repoUrl(ctx, a.repoName), wsDir]);
  const head = await git(ctx, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}^{commit}`], { cwd: wsDir, check: false });
  if (head.code !== 0) throw new Stop("failed", { error: `Branch "${branch}" is not in your workspace repo. Push it first.` });
  const headSha = head.stdout.trim();

  let base = null;
  for (const s of [...(a.syncs || [])].reverse()) {
    const r = await git(ctx, ["merge-base", "--is-ancestor", s.workspaceSha, headSha], { cwd: wsDir, check: false });
    if (r.code === 0) {
      base = s;
      break;
    }
  }
  if (!base) throw new Stop("rejected", { error: `Branch "${branch}" does not start from your workspace's main. Branch off main and try again.` });

  const raw = await git(ctx, ["diff", "--raw", "-z", "--no-renames", base.workspaceSha, headSha, "--", ".", ...EXCLUDE], { cwd: wsDir });
  const changes = parseRawDiff(raw.stdout);
  if (!changes.length) throw new Stop("rejected", { error: `Branch "${branch}" has no changes yet.` });
  const changedFiles = changes.map((c) => c.path);

  const { offending } = checkChangedFiles(changes, a);
  if (offending.length) {
    throw new Stop("rejected", { error: "This branch changes files outside your assignment.", offending, changedFiles });
  }

  const patch = (await git(ctx, ["diff", "--binary", "--no-renames", base.workspaceSha, headSha, "--", ...changedFiles], { cwd: wsDir })).stdout;
  if (Buffer.byteLength(patch) > MAX_PATCH_BYTES) throw new Stop("rejected", { error: "The change is larger than 5 MB.", changedFiles });

  const findings = scanPatch(patch, changedFiles);
  if (findings.length && !ctx.job.approved) {
    ctx.log.line(`Scan flagged ${findings.length} line(s); holding for an admin`);
    throw new Stop("held", { findings, changedFiles });
  }

  ctx.log.line(`Applying ${changedFiles.length} file(s) onto the latest ${ctx.main.branch}`);
  const mainSha = await cloneMain(ctx, mainDir);
  // The blobs the patch was made against, for the three-way merge.
  if (base.mainSha !== mainSha) {
    await git(ctx, ["fetch", "-q", "--depth", "1", "origin", base.mainSha], { cwd: mainDir });
  }
  const patchFile = path.join(ctx.dir, "change.patch");
  fs.writeFileSync(patchFile, patch, { mode: 0o600 });
  const applied = await git(ctx, ["apply", "--3way", "--index", "--whitespace=nowarn", patchFile], { cwd: mainDir, check: false });
  if (applied.code !== 0) {
    const conflicted = (await git(ctx, ["diff", "--name-only", "--diff-filter=U"], { cwd: mainDir, check: false })).stdout
      .split("\n").filter(Boolean);
    throw new Stop("failed", {
      error: "Your change conflicts with newer changes on main. Press Sync, merge main into your branch, fix the conflicts, then try again.",
      conflicts: conflicted.length ? conflicted : changedFiles,
      changedFiles,
    });
  }
  return { mainDir, mainSha, headSha, changedFiles };
}

module.exports = { prepareChange, Stop };
