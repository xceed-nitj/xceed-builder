// Send PR: the developer's change, applied on the latest main, pushed as a new
// branch of the main repo and opened as a pull request. The admin reviews and
// merges it from Pull & Deploy as before.
const { prepareChange } = require("./change");
const { git } = require("./workspace");
const { expect } = require("./github");

const CHECKS_START = "<!-- xceed-prod-checks -->";
const CHECKS_END = "<!-- /xceed-prod-checks -->";

function prBody({ description, checks, login, repoName, jobId, changedFiles }) {
  const items = checks.map((c) => `- [ ] ${c.replace(/\r?\n/g, " ")}`).join("\n");
  return [
    description || "",
    "",
    "## What to check in production",
    "",
    CHECKS_START,
    items,
    CHECKS_END,
    "",
    "---",
    `Sent from XCEED Dev Workspace by @${login} (workspace \`${repoName}\`).`,
    "",
    "<details><summary>Files changed</summary>",
    "",
    ...changedFiles.map((f) => `- \`${f}\``),
    "",
    "</details>",
    "",
    `<!-- xceed-devws job=${jobId} -->`,
  ].join("\n");
}

async function sendPr(ctx) {
  const a = ctx.assignment;
  const { branch, title, description, checks } = ctx.job.payload;
  const { mainDir, changedFiles } = await prepareChange(ctx, { branch });

  const shortRepo = a.repoName.split("/")[1];
  const prBranch = `devws/${shortRepo}-${ctx.job.id.slice(-6)}`;
  const author = { name: a.githubUsername, email: `${a.githubUsername}@users.noreply.github.com` };

  await git(ctx, ["switch", "-q", "-c", prBranch], { cwd: mainDir });
  await git(ctx, ["commit", "-q", "-m", `${title}\n\nFrom XCEED Dev Workspace ${a.repoName}.`], { cwd: mainDir, author });
  ctx.log.line(`Pushing ${prBranch} to ${ctx.main.repo}`);
  await git(ctx, ["push", "-q", "origin", `HEAD:refs/heads/${prBranch}`], { cwd: mainDir });

  const { data } = await expect(ctx.gh, "POST", `/repos/${ctx.main.repo}/pulls`, {
    title,
    head: prBranch,
    base: ctx.main.branch,
    body: prBody({ description, checks, login: a.githubUsername, repoName: a.repoName, jobId: ctx.job.id, changedFiles }),
    maintainer_can_modify: false,
  });
  ctx.log.line(`Opened PR #${data.number}`);
  return { status: "done", result: { prNumber: data.number, prUrl: data.html_url, branch: prBranch, changedFiles } };
}

module.exports = { sendPr, prBody, CHECKS_START, CHECKS_END };
