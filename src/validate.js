// What a developer's change may touch, and what in it needs an admin's eyes.
// Pure functions, no I/O: tested from server/tests/unit/devwsValidate.test.js.
//
// checkChangedFiles  every changed file must be inside a writable path; a
//                    view-only file or anything else rejects the whole change.
// scanPatch          looks at the ADDED lines only and flags code that reads
//                    files, runs commands, reads secrets, calls out to the
//                    network, or pulls other code into the browser bundle,
//                    plus any change to build config or dependencies. Flagged
//                    changes are held for an admin before anything runs.
//
// The scan deters; it cannot prove a change is safe. The preview's blocked
// network and the admin's review are the real protection.

const META_FILES = ["WORKSPACE.md", ".xceed-workspace.json"];

function covered(file, list) {
  return (list || []).some((entry) => (entry.endsWith("/") ? file.startsWith(entry) : file === entry));
}

/**
 * @param {Array<{path: string, mode?: string}>} changes  from `git diff --raw`
 * @returns {{ offending: string[] }}  each entry "path: reason"
 */
function checkChangedFiles(changes, { writablePaths, viewOnlyPaths }) {
  const offending = [];
  for (const { path, mode } of changes) {
    if (META_FILES.includes(path)) continue;
    if (mode === "120000") offending.push(`${path}: symbolic links are not allowed`);
    else if (mode === "160000") offending.push(`${path}: submodules are not allowed`);
    else if (covered(path, viewOnlyPaths)) offending.push(`${path}: view-only`);
    else if (!covered(path, writablePaths)) offending.push(`${path}: outside your assignment`);
  }
  return { offending };
}

const CODE_EXT = /\.(c?js|mjs|jsx|ts|tsx|py|sh|bash|vue|svelte|html?)$/i;
const SERVER_SIDE = /^(server|python-ml-service)\//;

// [rule, regex, appliesTo(file)]
const LINE_RULES = [
  ["runs system commands", /\bchild_process\b|\b(exec|execSync|execFile|spawn|spawnSync|fork)\s*\(|\bsubprocess\b|\bos\.system\b|\bos\.popen\b/],
  ["reads or writes files", /\brequire\s*\(\s*['"`](node:)?fs(\/promises)?['"`]\s*\)|\bfrom\s+['"`](node:)?fs(\/promises)?['"`]|\b(readFile|readFileSync|readdir|readdirSync|createReadStream|writeFile|writeFileSync|sendFile|sendfile)\s*\(|express\.static\s*\(|\bopen\s*\([^)]*['"][rwa]b?['"]/],
  ["evaluates code at runtime", /\beval\s*\(|\bnew\s+Function\s*\(|\bFunction\s*\(\s*['"`]|\bvm\.(run|Script)|\bexec\s*\(\s*compile/],
  // Not import.meta.env: in the browser it only ever holds VITE_ build values.
  ["reads environment variables", /\bprocess\.env\b|\bos\.environ\b|\bos\.getenv\b/],
  ["loads code from a computed path", /\brequire\s*\(\s*[^'"`\s)]|\bimport\s*\(\s*[^'"`\s)]|\b__import__\s*\(|importlib/],
  ["walks the file system", /\b__dirname\b|\b__filename\b|\bprocess\.cwd\s*\(|\bimport\.meta\.url\b/],
  ["pulls other files into the bundle", /\?(raw|url|inline|worker)['"`]|\bimport\.meta\.glob\b|['"`](\.\.\/)+server\//],
];
const SERVER_RULES = [
  ["makes network calls from the server", /\brequire\s*\(\s*['"`](node:)?(http|https|net|tls|dgram|dns|axios|node-fetch|got|undici)['"`]|\bfrom\s+['"`](node:)?(http|https|net|tls|dgram|dns|axios|node-fetch|got|undici)['"`]|\bfetch\s*\(|\brequests\.(get|post)|\burllib\b|\bsocket\.socket\b/],
];

// Changing any of these changes what runs at build or install time.
const CONFIG_FILES = [
  /(^|\/)package(-lock)?\.json$/,
  /(^|\/)(yarn\.lock|pnpm-lock\.yaml|\.npmrc|\.yarnrc(\.yml)?)$/,
  /(^|\/)(vite|webpack|rollup|babel|postcss|tailwind|jest|eslint)\.config\.[cm]?[jt]s$/,
  /(^|\/)(\.babelrc|tsconfig[^/]*\.json|Dockerfile|docker-compose[^/]*\.ya?ml|requirements[^/]*\.txt|setup\.py|pyproject\.toml)$/,
  /\.(sh|bash|ps1|bat|cmd)$/,
  /^server\/scripts\//,
  /^client\/scripts\//,
];

/**
 * Splits a unified diff into { file, line, text } for every added line.
 */
function addedLines(patch) {
  const out = [];
  let file = null;
  let line = 0;
  for (const raw of String(patch).split("\n")) {
    if (raw.startsWith("+++ ")) {
      const p = raw.slice(4).trim();
      file = p === "/dev/null" ? null : p.replace(/^b\//, "");
      continue;
    }
    if (raw.startsWith("@@")) {
      const m = raw.match(/\+(\d+)/);
      line = m ? Number(m[1]) : 0;
      continue;
    }
    if (!file || raw.startsWith("--- ") || raw.startsWith("diff --git")) continue;
    if (raw.startsWith("+")) {
      out.push({ file, line, text: raw.slice(1) });
      line += 1;
    } else if (raw.startsWith(" ")) {
      line += 1;
    }
  }
  return out;
}

/**
 * @returns {Array<{file, line, rule, text}>}  empty when nothing needs review
 */
function scanPatch(patch, changedFiles = []) {
  const findings = [];
  for (const f of changedFiles) {
    if (CONFIG_FILES.some((re) => re.test(f))) {
      findings.push({ file: f, line: 0, rule: "changes build, install or dependency config", text: "" });
    }
  }
  for (const { file, line, text } of addedLines(patch)) {
    if (!CODE_EXT.test(file)) continue;
    const rules = SERVER_SIDE.test(file) ? [...LINE_RULES, ...SERVER_RULES] : LINE_RULES;
    for (const [rule, re] of rules) {
      if (re.test(text)) findings.push({ file, line, rule, text: text.trim().slice(0, 200) });
    }
  }
  return findings.slice(0, 200);
}

/**
 * Parses `git diff --raw -z --no-renames` output into { path, mode }.
 * Each record is ":oldmode newmode oldsha newsha status\0path\0".
 */
function parseRawDiff(raw) {
  const parts = String(raw).split("\0").filter((p) => p !== "");
  const out = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const meta = parts[i].replace(/^:/, "").split(" ");
    const [oldMode, newMode] = meta;
    const status = meta[4] || "";
    // A deleted file keeps its old mode; anything else is judged by its new one.
    out.push({ path: parts[i + 1], mode: status.startsWith("D") ? oldMode : newMode, status });
  }
  return out;
}

module.exports = { checkChangedFiles, scanPatch, addedLines, parseRawDiff, covered, META_FILES };
