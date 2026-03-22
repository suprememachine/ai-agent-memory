// AIAgent — supports Gemini, Qwen, OpenAI, or any OpenAI-compatible API
const OpenAI = require("openai");
const { GitHubMemory } = require("./memory");
const { SkillRegistry } = require("./skillRegistry");
const { SkillExecutor } = require("./skillExecutor");

const PROVIDERS = {
  gemini: {
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
    apiKeyEnv: "GEMINI_API_KEY",
    defaultModel: "gemini-2.0-flash",
    jsonMode: "prompt", // Gemini does NOT support response_format: json_object
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
    baseURL: null, // reads CUSTOM_BASE_URL env
    apiKeyEnv: "CUSTOM_API_KEY",
    defaultModel: "gpt-4o-mini",
    jsonMode: "prompt",
  },
};

const ORCHESTRATOR_SYSTEM = `You are a powerful AI agent with access to a dynamic skill system.

Your job:
1. Understand what the user wants
2. Decide which skills to use (can chain multiple skills)
3. Extract parameters for each skill
4. Use skill results to generate a helpful response

AVAILABLE SKILLS:
{SKILLS_LIST}

RESPONSE FORMAT — You MUST respond with ONLY valid JSON. No markdown, no backticks, no explanation.
Output exactly this structure:
{
  "thinking": "brief reasoning about what user wants",
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

USER MEMORY CONTEXT:
{MEMORY_CONTEXT}`;

class AIAgent {
  constructor() {
    const providerName = (process.env.LLM_PROVIDER || "qwen").toLowerCase();
    const cfg = PROVIDERS[providerName] || PROVIDERS.custom;

    const apiKey = process.env[cfg.apiKeyEnv] || process.env.LLM_API_KEY || "no-key";
    const baseURL = providerName === "custom"
      ? (process.env.CUSTOM_BASE_URL || undefined)
      : cfg.baseURL;

    this.client = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
    this.model = process.env.MODEL_NAME || cfg.defaultModel;
    this.jsonMode = cfg.jsonMode;
    this.providerName = providerName;

    this.memory = new GitHubMemory();
    this.skillRegistry = new SkillRegistry();
    this.executor = new SkillExecutor();

    console.log(`🤖 Provider: ${providerName} | Model: ${this.model} | JSON mode: ${this.jsonMode}`);
  }

  async process(userId, message, sessionId, sendCallback = null) {
    const [memories, activeSkills] = await Promise.all([
      this.memory.loadMemory(userId),
      this.skillRegistry.getActiveSkills(userId)
    ]);

    const currentSession = sessionId || `tg_${Date.now()}`;
    const memoryContext = this._buildMemoryContext(memories, currentSession);
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
      finalResponse = await this._synthesizeResponse(message, skillResults, memories, currentSession);
    }

    await this._saveToMemory(userId, currentSession, message, finalResponse);

    return {
      response: finalResponse,
      sessionId: currentSession,
      skillsUsed: skillResults.map(r => ({ skill: r.skill, success: r.success })),
      thinking: orchestration.thinking,
      provider: this.providerName,
      model: this.model,
    };
  }

  // Provider-aware LLM call
  async _callLLM(messages, { temperature = 0.7, max_tokens = 2000, jsonMode = false } = {}) {
    const opts = { model: this.model, messages, temperature, max_tokens };
    if (jsonMode && this.jsonMode === "response_format") {
      opts.response_format = { type: "json_object" };
    }
    const res = await this.client.chat.completions.create(opts);
    return res.choices[0].message.content;
  }

  // Parse JSON — handles markdown code fences Gemini sometimes adds
  _parseJSON(raw) {
    let clean = raw.trim();
    // Strip ```json ... ``` or ``` ... ```
    if (clean.startsWith("```")) {
      clean = clean.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();
    }
    // Find outermost { } in case there's stray text
    const start = clean.indexOf("{");
    const end = clean.lastIndexOf("}");
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
      r.success ? `[${r.skill}] Result:\n${JSON.stringify(r.result, null, 2)}` : `[${r.skill}] ERROR: ${r.error}`
    ).join("\n\n");

    const history = this._buildConversationHistory(memories, currentSession);
    const messages = [
      {
        role: "system",
        content: `You are a helpful AI assistant. Synthesize a natural, helpful response in the SAME LANGUAGE as the user. Format nicely for Telegram (use markdown where appropriate).`
      },
      ...history,
      { role: "user", content: originalMessage },
      { role: "system", content: `SKILL EXECUTION RESULTS:\n${skillSummary}\n\nNow respond to the user.` }
    ];
    return await this._callLLM(messages, { temperature: 0.7, max_tokens: 2000 });
  }

  _buildMemoryContext(memories, currentSession) {
    if (!memories?.sessions) return "No previous conversations.";
    const sessions = Object.entries(memories.sessions)
      .filter(([id]) => id !== currentSession)
      .sort(([, a], [, b]) => new Date((b[b.length-1]?.timestamp||0)) - new Date((a[a.length-1]?.timestamp||0)))
      .slice(0, 2);
    if (sessions.length === 0) return "First conversation with this user.";
    return sessions.map(([id, msgs]) => {
      const recent = msgs.slice(-3).map(m => `${m.role}: ${m.content.substring(0,100)}`).join("\n");
      return `Session ${id.split("_").pop()}:\n${recent}`;
    }).join("\n---\n");
  }

  _buildConversationHistory(memories, currentSession) {
    if (!memories?.sessions?.[currentSession]) return [];
    return memories.sessions[currentSession].slice(-10).map(({ role, content }) => ({ role, content }));
  }

  async _saveToMemory(userId, sessionId, userMsg, assistantMsg) {
    const ts = new Date().toISOString();
    await this.memory.saveMessage(userId, sessionId, { role: "user", content: userMsg, timestamp: ts });
    await this.memory.saveMessage(userId, sessionId, { role: "assistant", content: assistantMsg, timestamp: ts });
  }

  async addSkill(userId, d)          { return this.skillRegistry.addSkill(userId, d); }
  async removeSkill(userId, n)       { return this.skillRegistry.removeSkill(userId, n); }
  async toggleSkill(userId, n, e)    { return this.skillRegistry.toggleSkill(userId, n, e); }
  async listSkills(userId)           { return this.skillRegistry.listSkills(userId); }
  async clearMemory(userId)          { return this.memory.clearMemory(userId); }
  async getMemorySummary(userId) {
    const m = await this.memory.loadMemory(userId);
    if (!m?.sessions) return { totalSessions: 0, totalMessages: 0 };
    const s = Object.entries(m.sessions);
    return { totalSessions: s.length, totalMessages: s.reduce((t,[,msgs])=>t+msgs.length,0) };
  }
}

module.exports = { AIAgent };
