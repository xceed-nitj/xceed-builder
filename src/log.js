// The job's log. Written to a file in the job's private work folder and kept
// in memory for the heartbeat, and NEVER printed: on GitHub Actions the
// builder repo is public, so anything on stdout would be readable by anyone.
// Secrets are masked before a line is stored anywhere.
const fs = require("fs");

const TAIL_MAX = 48 * 1024;

class JobLog {
  constructor(file, secrets = []) {
    this.file = file;
    this.secrets = secrets.filter((s) => s && s.length >= 6);
    this.tail = "";
    this.fd = file ? fs.openSync(file, "a", 0o600) : null;
  }

  mask(text) {
    let out = String(text);
    for (const s of this.secrets) out = out.split(s).join("***");
    // Anything that looks like a GitHub token, whatever its source.
    return out.replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "***");
  }

  write(text) {
    const clean = this.mask(text);
    if (this.fd !== null) fs.writeSync(this.fd, clean);
    this.tail = (this.tail + clean).slice(-TAIL_MAX);
  }

  line(text) {
    this.write(`[${new Date().toISOString().slice(11, 19)}] ${text}\n`);
  }

  close() {
    if (this.fd !== null) fs.closeSync(this.fd);
    this.fd = null;
  }
}

module.exports = { JobLog };
