const { Octokit } = require("@octokit/rest");

class GitHubMemory {
  constructor() {
    this.octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
    this.owner = process.env.GITHUB_OWNER;
    this.repo = process.env.GITHUB_REPO;
    this.branch = process.env.GITHUB_BRANCH || "main";
    this.basePath = process.env.MEMORY_PATH || "memory";
  }

  // ── Generic file operations ────────────────────────────────────────────
  async loadFile(relativePath) {
    try {
      const res = await this.octokit.repos.getContent({
        owner: this.owner, repo: this.repo,
        path: `${this.basePath}/${relativePath}`,
        ref: this.branch
      });
      const content = Buffer.from(res.data.content, "base64").toString("utf-8");
      const data = JSON.parse(content);
      data._sha = res.data.sha;
      return data;
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  }

  async saveFile(relativePath, data, message = null) {
    const existing = await this.loadFile(relativePath).catch(() => null);
    const sha = existing?._sha;
    const cleanData = { ...data };
    delete cleanData._sha;

    const content = Buffer.from(JSON.stringify(cleanData, null, 2)).toString("base64");
    await this.octokit.repos.createOrUpdateFileContents({
      owner: this.owner, repo: this.repo,
      path: `${this.basePath}/${relativePath}`,
      message: message || `Update ${relativePath}`,
      content,
      branch: this.branch,
      ...(sha ? { sha } : {})
    });
    return true;
  }

  // ── Memory shortcuts ──────────────────────────────────────────────────
  async loadMemory(userId) {
    return await this.loadFile(`conversations/${userId}.json`) || { sessions: {} };
  }

  async saveMessage(userId, sessionId, message) {
    const maxRetries = 3;
    for (let i = 0; i < maxRetries; i++) {
      try {
        const memory = await this.loadMemory(userId);
        const sha = memory._sha;
        delete memory._sha;

        if (!memory.sessions) memory.sessions = {};
        if (!memory.sessions[sessionId]) memory.sessions[sessionId] = [];
        memory.sessions[sessionId].push(message);
        memory.updatedAt = new Date().toISOString();

        // Trim per session
        if (memory.sessions[sessionId].length > 50)
          memory.sessions[sessionId] = memory.sessions[sessionId].slice(-50);

        // Trim total sessions
        const keys = Object.keys(memory.sessions);
        if (keys.length > 10) {
          const sorted = keys.sort((a, b) => {
            const la = memory.sessions[a].slice(-1)[0]?.timestamp || 0;
            const lb = memory.sessions[b].slice(-1)[0]?.timestamp || 0;
            return new Date(la) - new Date(lb);
          });
          delete memory.sessions[sorted[0]];
        }

        const content = Buffer.from(JSON.stringify(memory, null, 2)).toString("base64");
        await this.octokit.repos.createOrUpdateFileContents({
          owner: this.owner, repo: this.repo,
          path: `${this.basePath}/conversations/${userId}.json`,
          message: `Memory update: ${userId}`,
          content, branch: this.branch,
          ...(sha ? { sha } : {})
        });
        return true;
      } catch (e) {
        if (e.status === 409 && i < maxRetries - 1) {
          await new Promise(r => setTimeout(r, 500 * (i + 1)));
          continue;
        }
        throw e;
      }
    }
  }

  async clearMemory(userId) {
    const memory = await this.loadMemory(userId);
    const sha = memory._sha;
    const fresh = { sessions: {}, clearedAt: new Date().toISOString() };
    const content = Buffer.from(JSON.stringify(fresh, null, 2)).toString("base64");
    await this.octokit.repos.createOrUpdateFileContents({
      owner: this.owner, repo: this.repo,
      path: `${this.basePath}/conversations/${userId}.json`,
      message: `Clear memory: ${userId}`,
      content, branch: this.branch,
      ...(sha ? { sha } : {})
    });
    return true;
  }

  async ensureRepoSetup() {
    const dirs = ["conversations", "skills"];
    for (const dir of dirs) {
      try {
        await this.octokit.repos.getContent({
          owner: this.owner, repo: this.repo,
          path: `${this.basePath}/${dir}/.gitkeep`
        });
      } catch (e) {
        if (e.status === 404) {
          await this.octokit.repos.createOrUpdateFileContents({
            owner: this.owner, repo: this.repo,
            path: `${this.basePath}/${dir}/.gitkeep`,
            message: `Init ${dir} directory`,
            content: Buffer.from("").toString("base64"),
            branch: this.branch
          });
        }
      }
    }
    console.log("✅ GitHub repo structure verified");
  }
}

module.exports = { GitHubMemory };
