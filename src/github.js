// GitHub with the org token (ORG_TOKEN). Used only by the builder; XCEED
// never holds this token.
//
// git gets the token through GIT_CONFIG_* environment variables rather than a
// URL or a -c argument: a command line is visible to every account on the
// machine (ps), an environment is not.

function api(token, fetchImpl = fetch) {
  return async function request(method, path, body) {
    const res = await fetchImpl(`https://api.github.com${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "xceed-dev-workspace-builder",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000),
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { message: text.slice(0, 200) }; }
    return { status: res.status, data };
  };
}

/** Throws with GitHub's message unless the status is one of `ok`. */
async function expect(request, method, path, body, ok = [200, 201, 204]) {
  const res = await request(method, path, body);
  if (!ok.includes(res.status)) {
    const msg = res.data?.message || "";
    const errors = Array.isArray(res.data?.errors) ? ` (${res.data.errors.map((e) => e.message || e.code).join("; ")})` : "";
    throw new Error(`GitHub ${method} ${path.split("?")[0]} answered ${res.status}: ${msg}${errors}`);
  }
  return res;
}

/** Environment that lets git authenticate to github.com with the token. */
function gitAuthEnv(token) {
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
    GIT_TERMINAL_PROMPT: "0",
  };
}

const BOT = { name: "XCEED Dev Workspace", email: "devws-bot@users.noreply.github.com" };

function gitIdentityEnv(author = BOT) {
  return {
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_COMMITTER_NAME: BOT.name,
    GIT_COMMITTER_EMAIL: BOT.email,
  };
}

module.exports = { api, expect, gitAuthEnv, gitIdentityEnv, BOT };
