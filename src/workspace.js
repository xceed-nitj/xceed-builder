// The three jobs that manage a workspace repo: create it (provision), bring
// its files up to date with main (sync), and take access away (revoke).
//
// A workspace repo holds ONLY the assignment's files, at the same paths as in
// the main repo, plus two files of ours: WORKSPACE.md (what to do, the rules)
// and .xceed-workspace.json (which main commit the copy came from).
const fs = require("fs");
const path = require("path");
const { run } = require("./exec");
const { expect, gitAuthEnv, gitIdentityEnv } = require("./github");

// DEVWS_GIT_BASE swaps github.com for a folder of local bare repos, so the
// git steps can be tested without GitHub (server/tests/unit/devwsBuilderGit.test.js).
function repoUrl(ctx, fullName) {
  return `${ctx.gitBase || "https://github.com"}/${fullName}.git`;
}

function git(ctx, args, opts = {}) {
  return run("git", args, {
    cwd: opts.cwd,
    log: ctx.log,
    env: { ...ctx.baseEnv, ...gitAuthEnv(ctx.token), ...gitIdentityEnv(opts.author) },
    check: opts.check !== false,
  });
}

async function cloneMain(ctx, dir) {
  const { repo, branch } = ctx.main;
  await git(ctx, ["clone", "--depth", "1", "--branch", branch, "--no-tags", repoUrl(ctx, repo), dir]);
  const sha = (await git(ctx, ["rev-parse", "HEAD"], { cwd: dir })).stdout.trim();
  return sha;
}

function copyPath(fromRoot, toRoot, rel) {
  const src = path.join(fromRoot, rel);
  if (!fs.existsSync(src)) return false;
  const dest = path.join(toRoot, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  // dereference: false — a symlink in main is copied as a link, never followed
  // out of the checkout.
  fs.cpSync(src, dest, { recursive: true, dereference: false, filter: (p) => !p.split(path.sep).includes(".git") });
  return true;
}

function workspaceReadme(a, mainRepo, mainSha) {
  const list = (paths) => (paths.length ? paths.map((p) => `- \`${p}\``).join("\n") : "- (none)");
  return `# XCEED Dev Workspace

${a.taskNote ? `## Your task\n\n${a.taskNote}\n\n` : ""}## Files you can change

${list(a.writablePaths)}

## Files for reference only (do not change)

${list(a.viewOnlyPaths)}

## How to work

1. Make a branch: \`git switch -c my-change\`. Never push to \`main\`.
2. Change only the files listed above, then push your branch.
3. In XCEED, open **Dev Workspace**, type your branch name, and press **Test**
   to get a private preview of the full site with your change and test logins.
4. When it works, press **Send PR** and list what to check in production.
5. If XCEED tells you the workspace was synced, run
   \`git fetch && git merge origin/main\` on your branch before testing again.

Changes to any other file are rejected when you press Test or Send PR.
Code that reads files, runs commands, reads secrets or calls the network is
held for an admin to review first.

Copied from ${mainRepo} at ${mainSha.slice(0, 12)}. Access ends ${new Date(a.endsAt).toDateString()}.
`;
}

function writeMeta(dir, a, mainRepo, mainSha) {
  fs.writeFileSync(path.join(dir, "WORKSPACE.md"), workspaceReadme(a, mainRepo, mainSha));
  fs.writeFileSync(
    path.join(dir, ".xceed-workspace.json"),
    `${JSON.stringify({ mainRepo, mainSha, writablePaths: a.writablePaths, viewOnlyPaths: a.viewOnlyPaths }, null, 2)}\n`,
  );
}

function splitRepo(full) {
  const [owner, name] = String(full).split("/");
  if (!owner || !name || !/^[A-Za-z0-9._-]+$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error(`Bad repo name "${full}"`);
  }
  return { owner, name };
}

async function provision(ctx) {
  const a = ctx.assignment;
  const { owner, name } = splitRepo(a.repoName);
  const mainDir = path.join(ctx.dir, "main");
  const wsDir = path.join(ctx.dir, "ws");

  ctx.log.line(`Copying assigned files from ${ctx.main.repo}`);
  const mainSha = await cloneMain(ctx, mainDir);
  fs.mkdirSync(wsDir);
  const missing = [...a.writablePaths, ...a.viewOnlyPaths].filter((p) => !copyPath(mainDir, wsDir, p));
  if (missing.length) ctx.log.line(`Not in main any more (skipped): ${missing.join(", ")}`);
  writeMeta(wsDir, a, ctx.main.repo, mainSha);

  ctx.log.line(`Creating private repo ${a.repoName}`);
  const created = await ctx.gh("POST", `/orgs/${owner}/repos`, {
    name,
    private: true,
    description: `XCEED Dev Workspace for @${a.githubUsername}`,
    has_issues: false,
    has_projects: false,
    has_wiki: false,
    auto_init: false,
  });
  if (created.status === 422) {
    ctx.log.line("Repo already exists (an earlier attempt); reusing it");
  } else if (created.status !== 201) {
    throw new Error(`Could not create ${a.repoName}: ${created.status} ${created.data?.message || ""}`);
  }

  await git(ctx, ["init", "-q", "-b", "main"], { cwd: wsDir });
  await git(ctx, ["add", "-A"], { cwd: wsDir });
  await git(ctx, ["commit", "-q", "-m", `Workspace created from ${ctx.main.repo}@${mainSha.slice(0, 12)}`], { cwd: wsDir });
  const push = await git(ctx, ["push", "-q", repoUrl(ctx, a.repoName), "main"], { cwd: wsDir, check: false });
  if (push.code !== 0) throw new Error("Could not push to the workspace repo (it may already have commits from an earlier attempt)");
  const workspaceSha = (await git(ctx, ["rev-parse", "HEAD"], { cwd: wsDir })).stdout.trim();

  ctx.log.line(`Inviting @${a.githubUsername} with write access`);
  await expect(ctx.gh, "PUT", `/repos/${a.repoName}/collaborators/${encodeURIComponent(a.githubUsername)}`, { permission: "push" });

  return {
    status: "done",
    result: { repoName: a.repoName, repoUrl: `https://github.com/${a.repoName}`, workspaceSha, mainSha },
  };
}

async function sync(ctx) {
  const a = ctx.assignment;
  splitRepo(a.repoName);
  const mainDir = path.join(ctx.dir, "main");
  const wsDir = path.join(ctx.dir, "ws");

  const mainSha = await cloneMain(ctx, mainDir);
  await git(ctx, ["clone", "-q", "--branch", "main", repoUrl(ctx, a.repoName), wsDir]);
  // Replace every assigned path with main's current version. A file removed
  // from main, or a path taken out of the assignment, disappears here too.
  for (const entry of fs.readdirSync(wsDir)) {
    if (entry !== ".git") fs.rmSync(path.join(wsDir, entry), { recursive: true, force: true });
  }
  for (const p of [...a.writablePaths, ...a.viewOnlyPaths]) copyPath(mainDir, wsDir, p);
  writeMeta(wsDir, a, ctx.main.repo, mainSha);

  await git(ctx, ["add", "-A"], { cwd: wsDir });
  const changed = (await git(ctx, ["status", "--porcelain"], { cwd: wsDir })).stdout.trim();
  if (!changed) {
    ctx.log.line("Already up to date with main");
    return { status: "done", result: { phase: "unchanged", mainSha } };
  }
  await git(ctx, ["commit", "-q", "-m", `Sync with ${ctx.main.repo}@${mainSha.slice(0, 12)}`], { cwd: wsDir });
  await git(ctx, ["push", "-q", "origin", "main"], { cwd: wsDir });
  const workspaceSha = (await git(ctx, ["rev-parse", "HEAD"], { cwd: wsDir })).stdout.trim();
  return { status: "done", result: { phase: "synced", workspaceSha, mainSha } };
}

async function revoke(ctx) {
  const a = ctx.assignment;
  splitRepo(a.repoName);
  const login = encodeURIComponent(a.githubUsername);

  const removed = await ctx.gh("DELETE", `/repos/${a.repoName}/collaborators/${login}`);
  if (![204, 404].includes(removed.status)) throw new Error(`Could not remove @${a.githubUsername}: ${removed.status}`);

  // An invitation not yet accepted would still let them in later.
  const invites = await ctx.gh("GET", `/repos/${a.repoName}/invitations?per_page=100`);
  if (invites.status === 200) {
    for (const inv of invites.data || []) {
      if (String(inv.invitee?.login || "").toLowerCase() === a.githubUsername.toLowerCase()) {
        await expect(ctx.gh, "DELETE", `/repos/${a.repoName}/invitations/${inv.id}`, undefined, [204, 404]);
      }
    }
  }

  // Archived, not deleted: the history of what they did stays for the admins.
  const archived = await ctx.gh("PATCH", `/repos/${a.repoName}`, { archived: true });
  if (![200, 404].includes(archived.status)) throw new Error(`Could not archive ${a.repoName}: ${archived.status}`);
  ctx.log.line(archived.status === 404 ? "Repo never existed; nothing to archive" : "Access removed and repo archived");
  return { status: "done", result: { phase: "revoked" } };
}

module.exports = { provision, sync, revoke, cloneMain, git, repoUrl, splitRepo, copyPath, workspaceReadme };
