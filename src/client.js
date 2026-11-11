// Talking to XCEED. Every request is signed with DEVWS_WORKER_SECRET the way
// server/src/modules/devWorkspaceModule/workerAuth.js checks it:
//   X-Signature = hex HMAC-SHA256(secret, `${ts}.${METHOD}.${path}.${body}`)
const crypto = require("crypto");

function sign(secret, ts, method, path, body) {
  return crypto.createHmac("sha256", secret).update(`${ts}.${method.toUpperCase()}.${path}.${body || ""}`).digest("hex");
}

function createClient({ baseUrl, secret, runnerId, fetchImpl = fetch }) {
  if (!baseUrl || !secret) throw new Error("XCEED_URL and DEVWS_WORKER_SECRET are required");
  const origin = new URL(baseUrl).origin;
  if (!origin.startsWith("https://") && !/^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(origin)) {
    throw new Error("XCEED_URL must be https (or a local address for testing)");
  }

  async function call(method, path, body, { retries = 3 } = {}) {
    const full = `/api/v1/devws/worker${path}`;
    const raw = JSON.stringify(body || {});
    for (let attempt = 1; ; attempt += 1) {
      const ts = Date.now();
      try {
        const res = await fetchImpl(`${origin}${full}`, {
          method,
          headers: {
            "Content-Type": "application/json",
            "X-Timestamp": String(ts),
            "X-Signature": sign(secret, ts, method, full, raw),
            "X-Runner-Id": runnerId,
          },
          body: raw,
          signal: AbortSignal.timeout(30000),
        });
        if (res.status === 204) return { status: 204, body: null };
        const text = await res.text();
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { json = { message: text.slice(0, 200) }; }
        // XCEED restarting (a deploy) answers 502/503 for a minute: wait it out.
        if (res.status >= 500 && attempt < retries) throw Object.assign(new Error(`HTTP ${res.status}`), { retry: true });
        return { status: res.status, body: json };
      } catch (err) {
        if (attempt >= retries) throw err;
        await new Promise((r) => setTimeout(r, 5000 * attempt));
      }
    }
  }

  return {
    claimNext: () => call("POST", "/claim", {}),
    claim: (id) => call("POST", `/jobs/${id}/claim`, {}),
    heartbeat: (id, logTail, result) => call("POST", `/jobs/${id}/heartbeat`, { logTail, result }),
    complete: (id, status, logTail, result) => call("POST", `/jobs/${id}/complete`, { status, logTail, result }, { retries: 6 }),
  };
}

module.exports = { createClient, sign };
