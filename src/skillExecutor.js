// SkillExecutor — eksekusi setiap skill berdasarkan tipe dan definisi
const axios = require("axios");

// Globals yang dishadow menjadi undefined di dalam sandbox
const SHADOW_GLOBALS = [
  "process", "require", "module", "exports", "__dirname", "__filename",
  "Buffer", "global", "globalThis", "setTimeout", "setInterval",
  "setImmediate", "clearTimeout", "clearInterval", "clearImmediate", "queueMicrotask"
  // Note: "eval" dan "Function" tidak bisa jadi param name — dishadow via `var` di dalam kode
];

// Safe globals yang di-inject ke sandbox
const SAFE_PARAM_NAMES = [
  "console", "Math", "JSON", "Date", "Array", "Object",
  "String", "Number", "Boolean", "parseInt", "parseFloat",
  "isNaN", "isFinite", "Map", "Set", "Promise", "RegExp",
  "Error", "TypeError", "RangeError",
  ...SHADOW_GLOBALS
];

class SkillExecutor {
  async execute(skillName, skillDef, params, context = {}) {
    const startTime = Date.now();
    try {
      let result;
      if (skillDef.builtin) {
        switch (skillName) {
          case "web_search":     result = await this.executeWebSearch(params); break;
          case "code_runner":    result = await this.executeCode(params); break;
          case "http_request":   result = await this.executeHTTP(params); break;
          case "text_transform": result = await this.executeTextTransform(params); break;
          case "reminder":       result = await this.executeReminder(params, context); break;
          case "image_generate": result = await this.executeImageGenerate(params); break;
          default: result = { error: `Unknown builtin skill: ${skillName}` };
        }
      } else if (skillDef.webhook_url) {
        result = await this.executeWebhook(skillDef, params);
      } else if (skillDef.instruction) {
        result = { type: "llm_instruction", instruction: skillDef.instruction, params };
      } else {
        result = { error: "Skill tidak memiliki executor" };
      }
      return { skill: skillName, success: true, result, executionMs: Date.now() - startTime };
    } catch (err) {
      return { skill: skillName, success: false, error: err.message, executionMs: Date.now() - startTime };
    }
  }

  // ── Web Search via DuckDuckGo (no API key needed) ──────────────────────
  async executeWebSearch({ query }) {
    try {
      const res = await axios.get("https://api.duckduckgo.com/", {
        params: { q: query, format: "json", no_html: 1, skip_disambig: 1 },
        timeout: 8000,
        headers: { "User-Agent": "TelegramAIAgent/2.0" }
      });
      const d = res.data;
      const results = [];
      if (d.AbstractText) results.push({ title: d.Heading, snippet: d.AbstractText, url: d.AbstractURL });
      if (d.Answer) results.unshift({ type: "instant_answer", text: d.Answer });
      (d.RelatedTopics || []).slice(0, 4).forEach(t => {
        if (t.Text) results.push({ snippet: t.Text, url: t.FirstURL });
      });
      return {
        query,
        results: results.length > 0 ? results : [{ snippet: "Tidak ada hasil langsung. Coba query lebih spesifik." }],
        source: "DuckDuckGo"
      };
    } catch (err) {
      return {
        query,
        results: [{ snippet: `Cari di Google: https://www.google.com/search?q=${encodeURIComponent(query)}` }],
        error: err.message
      };
    }
  }

  // ── Code Runner — hardened JS sandbox ─────────────────────────────────
  async executeCode({ code, language = "js" }) {
    if (language === "python") {
      return { language: "python", code, note: "Python code akan dianalisis oleh LLM.", simulated: true };
    }
    return new Promise((resolve) => {
      const logs = [];
      const timer = setTimeout(() => resolve({ error: "Timeout: kode berjalan >3 detik" }), 3000);
      try {
        const safeValues = [
          { log: (...a) => logs.push(a.map(x => String(x)).join(" ")) }, // console
          Math, JSON, Date, Array, Object,
          String, Number, Boolean, parseInt, parseFloat,
          isNaN, isFinite, Map, Set, Promise, RegExp,
          Error, TypeError, RangeError,
          ...SHADOW_GLOBALS.map(() => undefined)
        ];

        // Prefix user code with `var eval=undefined,Function=undefined` to shadow those too
        const safeCode = `var eval=undefined,Function=undefined;\n${code}`;
        const fn = new Function(...SAFE_PARAM_NAMES, safeCode);
        const output = fn(...safeValues);
        clearTimeout(timer);
        resolve({
          output: output !== undefined ? String(output) : undefined,
          logs: logs.length > 0 ? logs : undefined,
          language: "javascript"
        });
      } catch (err) {
        clearTimeout(timer);
        resolve({ error: err.message, language: "javascript" });
      }
    });
  }

  // ── HTTP Request ───────────────────────────────────────────────────────
  async executeHTTP({ url, method = "GET", headers = {}, body = null }) {
    const blocked = ["localhost", "127.", "0.0.0.0", "192.168.", "10.", "172.16.", "169.254.", "::1", "[::"];
    if (blocked.some(b => url.includes(b))) {
      return { error: "URL ke internal network tidak diizinkan" };
    }
    try {
      const res = await axios({
        method: method.toLowerCase(), url,
        headers: { "User-Agent": "TelegramAIAgent/2.0", ...headers },
        data: body, timeout: 10000, maxContentLength: 100000
      });
      return {
        status: res.status,
        statusText: res.statusText,
        data: typeof res.data === "object" ? res.data : String(res.data).substring(0, 2000),
        contentType: res.headers["content-type"]
      };
    } catch (err) {
      return { error: err.message, status: err.response?.status, data: err.response?.data };
    }
  }

  // ── Text Transform (LLM handles it) ───────────────────────────────────
  async executeTextTransform({ text, action, options = {} }) {
    const instructions = {
      translate: `Terjemahkan teks ke ${options.target_lang || "Bahasa Inggris"}`,
      summarize: `Buat ringkasan singkat (${options.max_sentences || 3} kalimat)`,
      extract:   `Ekstrak ${options.extract_type || "poin-poin penting"}`,
      reformat:  `Format ulang sebagai ${options.format || "poin-poin bullet"}`,
      convert:   `Konversi ke ${options.target_format || "JSON"}`,
    };
    return {
      type: "llm_task",
      instruction: instructions[action] || `Lakukan '${action}' pada teks`,
      text, action, options
    };
  }

  // ── Reminder ───────────────────────────────────────────────────────────
  async executeReminder({ message, delay_minutes }, context) {
    const delayMs = delay_minutes * 60 * 1000;
    const fireAt = new Date(Date.now() + delayMs).toISOString();
    if (context.sendCallback) {
      setTimeout(async () => {
        try { await context.sendCallback(`⏰ *Reminder!*\n\n${message}`); }
        catch (e) { console.error("Reminder failed:", e.message); }
      }, delayMs);
    }
    return { scheduled: true, message, delay_minutes, fires_at: fireAt };
  }

  // ── Image Generate prompt optimizer ───────────────────────────────────
  async executeImageGenerate({ prompt, style = "realistic" }) {
    return {
      type: "image_prompt",
      original: prompt,
      optimized: `${prompt}, ${style} style, high quality, highly detailed, 8k`,
      try_at: `https://stablediffusionweb.com/#demo?prompt=${encodeURIComponent(prompt)}`,
      note: "Salin prompt ke Stable Diffusion, DALL-E, atau Midjourney untuk generate gambar."
    };
  }

  // ── Custom Webhook ─────────────────────────────────────────────────────
  async executeWebhook(skillDef, params) {
    const res = await axios.post(skillDef.webhook_url, {
      skill: skillDef.name, params, timestamp: new Date().toISOString()
    }, {
      timeout: 15000,
      headers: {
        "Content-Type": "application/json",
        ...(skillDef.webhook_secret ? { "X-Skill-Secret": skillDef.webhook_secret } : {})
      }
    });
    return { status: res.status, data: res.data, source: "webhook" };
  }
}

module.exports = { SkillExecutor };
