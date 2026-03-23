// AIAgent v2 — fully persistent memory, load all history from GitHub every chat
const OpenAI = require("openai");
const { GitHubMemory } = require("./memory");
const { SkillRegistry } = require("./skillRegistry");
const { SkillExecutor } = require("./skillExecutor");

const PROVIDERS = {
  gemini: {
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
    apiKeyEnv: "GEMINI_API_KEY",
    defaultModel: "gemini-2.0-flash",
    jsonMode: "prompt",
  },
  qwen: {
    baseURL: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    apiKeyEnv: "DASHSCOPE_API_KEY",
    defaultModel: "qwen-plus",
    jsonMode: "response_format",
  },
  openai: {
    baseURL: null,
    apiKeyEnv: "OPENAI_API_KEY",
    defaultModel: "gpt-4o-mini",
    jsonMode: "response_format",
  },
  custom: {
    baseURL: null,
    apiKeyEnv: "CUSTOM_API_KEY",
    defaultModel: "gpt-4o-mini",
    jsonMode: "prompt",
  },
};

const ORCHESTRATOR_SYSTEM = `You are a powerful AI agent with access to a dynamic skill system.
You have FULL MEMORY of all previous conversations with this user — always refer to past context when relevant.

Your job:
1. Understand what the user wants (consider conversation history)
2. Decide which skills to use (can chain multiple skills)
3. Extract parameters for each skill
4. Use skill results to generate a helpful response

AVAILABLE SKILLS:
{SKILLS_LIST}

RESPONSE FORMAT — You MUST respond with ONLY valid JSON. No markdown, no backticks, no explanation.
Output exactly this structure:
{
  "thinking": "brief reasoning about what user wants and relevant memory",
  "skills_to_use": [
    {
      "skill": "skill_name",
      "params": {},
      "reason": "why this skill"
    }
  ],
  "direct_response": null,
  "needs_followup": false
}

RULES:
- Simple chat/question → skills_to_use: [], direct_response: "your answer"
- User needs web info → web_search
- User wants calculation/code → code_runner
- User wants to call an API → http_request
- User wants text processing → text_transform
- Chain skills when needed
- ALWAYS respond in the SAME LANGUAGE as the user
- Custom skills with "llm_instruction" → execute the instruction yourself in direct_response
- OUTPUT ONLY THE JSON OBJECT — nothing before or after it
- If user refers to something from past ("tadi", "sebelumnya", "yang kemarin") → look it up in MEMORY

=== FULL CONVERSATION MEMORY ===
{MEMORY_CONTEXT}
=== END MEMORY ===`;

class AIAgent {
  constructor() {
    const providerName = (process.env.LLM_PROVIDER || "qwen").toLowerCase();
    const cfg = PROVIDERS[providerName] || PROVIDERS.custom;

    const apiKey = process.env[cfg.apiKeyEnv] || process.env.LLM_API_KEY || "no-key";
    const baseURL = providerName === "custom"
      ? (process.env.CUSTOM_BASE_URL || undefined)
      : cfg.baseURL;

    this.client       = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
    this.model        = process.env.MODEL_NAME || cfg.defaultModel;
    this.jsonMode     = cfg.jsonMode;
    this.providerName = providerName;

    this.memory        = new GitHubMemory();
    this.skillRegistry = new SkillRegistry();
    this.executor      = new SkillExecutor();

    // In-memory cache agar tidak fetch GitHub terus tiap pesan
    // Cache expire setiap 5 menit
    this._memCache     = new Map(); // userId → { data, ts }
    this.CACHE_TTL_MS  = 5 * 60 * 1000;

    console.log(`🤖 Provider: ${providerName} | Model: ${this.model} | JSON mode: ${this.jsonMode}`);
  }

  // ── Load memory dengan cache ──────────────────────────────────────────
  async _loadMemoryCached(userId) {
    const cached = this._memCache.get(userId);
    if (cached && Date.now() - cached.ts < this.CACHE_TTL_MS) {
      return cached.data;
    }
    // Cache miss — fetch dari GitHub
    const data = await this.memory.loadMemory(userId);
    this._memCache.set(userId, { data, ts: Date.now() });
    return data;
  }

  // Invalidate cache setelah save
  _invalidateCache(userId) {
    this._memCache.delete(userId);
  }

  async process(userId, message, sessionId, sendCallback = null) {
    // Load memory dari GitHub (dengan cache) + skills
    const [memories, activeSkills] = await Promise.all([
      this._loadMemoryCached(userId),
      this.skillRegistry.getActiveSkills(userId)
    ]);

    const currentSession = sessionId || `tg_${Date.now()}`;

    // Build full memory context — semua sesi, lebih banyak pesan
    const memoryContext = this._buildFullMemoryContext(memories, currentSession);

    const skillsPrompt = Object.values(activeSkills).map(s => {
      const params = Object.entries(s.parameters || {})
        .map(([k, v]) => `${k}${v.required ? "" : "?"}: ${v.type} (${v.description || ""})`)
        .join(", ");
      return `• ${s.name} [${s.category}]: ${s.description}${params ? `\n  params: {${params}}` : ""}`;
    }).join("\n");

    const systemPrompt = ORCHESTRATOR_SYSTEM
      .replace("{SKILLS_LIST}", skillsPrompt)
      .replace("{MEMORY_CONTEXT}", memoryContext);

    let orchestration;
    try {
      const raw = await this._callLLM(
        [{ role: "system", content: systemPrompt }, { role: "user", content: message }],
        { temperature: 0.3, max_tokens: 1000, jsonMode: true }
      );
      orchestration = this._parseJSON(raw);
    } catch (e) {
      console.error("Orchestration error:", e.message);
      orchestration = { skills_to_use: [], direct_response: null, thinking: "parse error" };
    }

    let skillResults = [];
    if (orchestration.skills_to_use?.length > 0) {
      skillResults = await this._executeSkillChain(
        orchestration.skills_to_use, activeSkills, { sendCallback, userId }
      );
    }

    let finalResponse;
    if (orchestration.direct_response) {
      finalResponse = orchestration.direct_response;
    } else {
      finalResponse = await this._synthesizeResponse(
        message, skillResults, memories, currentSession
      );
    }

    // Save ke GitHub + invalidate cache
    await this._saveToMemory(userId, currentSession, message, finalResponse);
    this._invalidateCache(userId);

    return {
      response: finalResponse,
      sessionId: currentSession,
      skillsUsed: skillResults.map(r => ({ skill: r.skill, success: r.success })),
      thinking: orchestration.thinking,
      provider: this.providerName,
      model: this.model,
    };
  }

  // ── Build FULL memory context — semua sesi, lebih banyak pesan ────────
  _buildFullMemoryContext(memories, currentSession) {
    if (!memories?.sessions) return "Belum ada riwayat percakapan.";

    const sessions = Object.entries(memories.sessions)
      .sort(([, a], [, b]) => {
        const ta = a[a.length-1]?.timestamp || 0;
        const tb = b[b.length-1]?.timestamp || 0;
        return new Date(tb) - new Date(ta);
      });

    if (sessions.length === 0) return "Percakapan pertama dengan user ini.";

    const parts = [];

    // Sesi saat ini — ambil 20 pesan terakhir (full context)
    const currentMsgs = memories.sessions[currentSession];
    if (currentMsgs?.length > 0) {
      parts.push(`[Sesi Saat Ini]`);
      const msgs = currentMsgs.slice(-20);
      msgs.forEach(m => {
        const role = m.role === "user" ? "User" : "Assistant";
        parts.push(`${role}: ${m.content.substring(0, 300)}`);
      });
    }

    // Sesi sebelumnya — ambil 5 sesi, masing-masing 6 pesan terakhir
    const prevSessions = sessions
      .filter(([id]) => id !== currentSession)
      .slice(0, 5);

    if (prevSessions.length > 0) {
      parts.push(`\n[Riwayat Sesi Sebelumnya]`);
      prevSessions.forEach(([id, msgs]) => {
        const ts = msgs[msgs.length-1]?.timestamp;
        const dateStr = ts ? new Date(ts).toLocaleDateString("id-ID") : "unknown";
        parts.push(`\n-- Sesi ${dateStr} --`);
        // Ambil 6 pesan terakhir per sesi
        msgs.slice(-6).forEach(m => {
          const role = m.role === "user" ? "User" : "Asst";
          parts.push(`${role}: ${m.content.substring(0, 200)}`);
        });
      });
    }

    return parts.join("\n");
  }

  // ── Build conversation history untuk synthesis ─────────────────────────
  _buildConversationHistory(memories, currentSession) {
    if (!memories?.sessions?.[currentSession]) return [];
    // Ambil 15 pesan terakhir dari sesi saat ini
    return memories.sessions[currentSession].slice(-15).map(({ role, content }) => ({ role, content }));
  }

  async _callLLM(messages, { temperature = 0.7, max_tokens = 2000, jsonMode = false } = {}) {
    const opts = { model: this.model, messages, temperature, max_tokens };
    if (jsonMode && this.jsonMode === "response_format") {
      opts.response_format = { type: "json_object" };
    }
    const res = await this.client.chat.completions.create(opts);
    return res.choices[0].message.content;
  }

  _parseJSON(raw) {
    let clean = raw.trim();
    if (clean.startsWith("```")) {
      clean = clean.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();
    }
    const start = clean.indexOf("{");
    const end   = clean.lastIndexOf("}");
    if (start !== -1 && end !== -1) clean = clean.slice(start, end + 1);
    return JSON.parse(clean);
  }

  async _executeSkillChain(skillsToUse, activeSkills, context) {
    const results = [];
    let previousResult = null;
    for (const skillCall of skillsToUse) {
      const skillDef = activeSkills[skillCall.skill];
      if (!skillDef) {
        results.push({ skill: skillCall.skill, success: false, error: "Skill tidak ditemukan" });
        continue;
      }
      let params = { ...skillCall.params };
      if (previousResult && params._use_previous) {
        params = { ...params, previous_result: previousResult };
        delete params._use_previous;
      }
      const result = await this.executor.execute(skillCall.skill, skillDef, params, context);
      results.push(result);
      previousResult = result.result;
    }
    return results;
  }

  async _synthesizeResponse(originalMessage, skillResults, memories, currentSession) {
    const skillSummary = skillResults.map(r =>
      r.success
        ? `[${r.skill}] Result:\n${JSON.stringify(r.result, null, 2)}`
        : `[${r.skill}] ERROR: ${r.error}`
    ).join("\n\n");

    const history = this._buildConversationHistory(memories, currentSession);
    const messages = [
      {
        role: "system",
        content: `You are a helpful AI assistant with full memory of past conversations.
Synthesize a natural, helpful response in the SAME LANGUAGE as the user.
Format nicely for Telegram (use markdown where appropriate).
If the user refers to something from past conversations, acknowledge it naturally.`
      },
      ...history,
      { role: "user", content: originalMessage },
      {
        role: "system",
        content: `SKILL EXECUTION RESULTS:\n${skillSummary}\n\nNow respond to the user based on these results and conversation history.`
      }
    ];
    return await this._callLLM(messages, { temperature: 0.7, max_tokens: 2000 });
  }

  async _saveToMemory(userId, sessionId, userMsg, assistantMsg) {
    const ts = new Date().toISOString();
    await this.memory.saveMessage(userId, sessionId, { role: "user", content: userMsg, timestamp: ts });
    await this.memory.saveMessage(userId, sessionId, { role: "assistant", content: assistantMsg, timestamp: ts });
  }

  async addSkill(userId, d)       { return this.skillRegistry.addSkill(userId, d); }
  async removeSkill(userId, n)    { return this.skillRegistry.removeSkill(userId, n); }
  async toggleSkill(userId, n, e) { return this.skillRegistry.toggleSkill(userId, n, e); }
  async listSkills(userId)        { return this.skillRegistry.listSkills(userId); }
  async clearMemory(userId)       { return this.memory.clearMemory(userId); }
  async getMemorySummary(userId) {
    const m = await this.memory.loadMemory(userId);
    if (!m?.sessions) return { totalSessions: 0, totalMessages: 0 };
    const s = Object.entries(m.sessions);
    return {
      totalSessions: s.length,
      totalMessages: s.reduce((t, [, msgs]) => t + msgs.length, 0),
      cached: this._memCache.has(userId),
    };
  }
}

module.exports = { AIAgent };
