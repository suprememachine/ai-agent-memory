// SkillRegistry — menyimpan, load, aktifkan, dan eksekusi semua skill
const { GitHubMemory } = require("./memory");

class SkillRegistry {
  constructor() {
    this.memory = new GitHubMemory();
    this.skills = new Map(); // name → skill definition
    this.builtinSkills = this._defineBuiltins();
  }

  // ── Built-in skills yang selalu tersedia ─────────────────────────────────
  _defineBuiltins() {
    return {
      web_search: {
        name: "web_search",
        description: "Search the internet for current information, news, facts",
        category: "research",
        builtin: true,
        parameters: {
          query: { type: "string", required: true, description: "Search query" }
        },
        examples: ["cari berita terbaru tentang AI", "search latest bitcoin price", "find information about X"]
      },
      code_runner: {
        name: "code_runner",
        description: "Execute JavaScript/Python-like code and return results",
        category: "compute",
        builtin: true,
        parameters: {
          code: { type: "string", required: true, description: "Code to execute" },
          language: { type: "string", required: false, description: "js or python (default: js)" }
        },
        examples: ["hitung 2^32", "buat fungsi fibonacci", "jalankan kode ini: ..."]
      },
      http_request: {
        name: "http_request",
        description: "Make HTTP requests to any API endpoint (GET, POST, PUT, DELETE)",
        category: "integration",
        builtin: true,
        parameters: {
          url: { type: "string", required: true },
          method: { type: "string", required: false, default: "GET" },
          headers: { type: "object", required: false },
          body: { type: "object", required: false }
        },
        examples: ["panggil API cuaca", "kirim data ke webhook", "ambil data dari URL ini"]
      },
      text_transform: {
        name: "text_transform",
        description: "Transform text: translate, summarize, reformat, extract, convert",
        category: "text",
        builtin: true,
        parameters: {
          text: { type: "string", required: true },
          action: { type: "string", required: true, description: "translate|summarize|extract|reformat|convert" },
          options: { type: "object", required: false }
        },
        examples: ["terjemahkan ke Inggris", "ringkas artikel ini", "ekstrak email dari teks"]
      },
      reminder: {
        name: "reminder",
        description: "Set a reminder or scheduled task to send message later",
        category: "productivity",
        builtin: true,
        parameters: {
          message: { type: "string", required: true },
          delay_minutes: { type: "number", required: true }
        },
        examples: ["ingatkan saya 10 menit lagi", "set reminder besok pagi"]
      },
      image_generate: {
        name: "image_generate",
        description: "Generate image description or prompt for image AI (Stable Diffusion, DALL-E, etc)",
        category: "creative",
        builtin: true,
        parameters: {
          prompt: { type: "string", required: true },
          style: { type: "string", required: false }
        },
        examples: ["buat gambar kucing astronaut", "generate ilustrasi pantai sunset"]
      }
    };
  }

  // ── Load skills dari GitHub ────────────────────────────────────────────
  async loadSkills(userId) {
    try {
      const data = await this.memory.loadFile(`skills/${userId}_skills.json`);
      if (data && data.custom) {
        for (const [name, skill] of Object.entries(data.custom)) {
          this.skills.set(name, { ...skill, builtin: false });
        }
      }
      return data;
    } catch (e) {
      return { custom: {}, disabled: [] };
    }
  }

  // ── Simpan skills ke GitHub ───────────────────────────────────────────
  async saveSkills(userId, skillsData) {
    await this.memory.saveFile(`skills/${userId}_skills.json`, skillsData);
  }

  // ── Tambah custom skill ───────────────────────────────────────────────
  async addSkill(userId, skillDef) {
    const data = await this.loadSkills(userId);
    if (!data.custom) data.custom = {};
    if (!data.disabled) data.disabled = [];

    // Validate skill structure
    if (!skillDef.name || !skillDef.description) {
      throw new Error("Skill harus punya 'name' dan 'description'");
    }

    data.custom[skillDef.name] = {
      name: skillDef.name,
      description: skillDef.description,
      category: skillDef.category || "custom",
      parameters: skillDef.parameters || {},
      instruction: skillDef.instruction || "",
      webhook_url: skillDef.webhook_url || null,
      examples: skillDef.examples || [],
      createdAt: new Date().toISOString()
    };

    await this.saveSkills(userId, data);
    this.skills.set(skillDef.name, data.custom[skillDef.name]);
    return data.custom[skillDef.name];
  }

  // ── Hapus skill ────────────────────────────────────────────────────────
  async removeSkill(userId, skillName) {
    const data = await this.loadSkills(userId);
    if (data.custom && data.custom[skillName]) {
      delete data.custom[skillName];
      this.skills.delete(skillName);
      await this.saveSkills(userId, data);
      return true;
    }
    return false;
  }

  // ── Disable/enable skill ──────────────────────────────────────────────
  async toggleSkill(userId, skillName, enabled) {
    const data = await this.loadSkills(userId);
    if (!data.disabled) data.disabled = [];
    if (!enabled) {
      if (!data.disabled.includes(skillName)) data.disabled.push(skillName);
    } else {
      data.disabled = data.disabled.filter(n => n !== skillName);
    }
    await this.saveSkills(userId, data);
    return true;
  }

  // ── Ambil semua skill aktif (builtin + custom) ────────────────────────
  async getActiveSkills(userId) {
    const data = await this.loadSkills(userId);
    const disabled = data?.disabled || [];
    const custom = data?.custom || {};

    const all = { ...this.builtinSkills, ...custom };
    return Object.fromEntries(
      Object.entries(all).filter(([name]) => !disabled.includes(name))
    );
  }

  // ── Format skill list untuk LLM system prompt ──────────────────────────
  async buildSkillsPrompt(userId) {
    const active = await this.getActiveSkills(userId);
    const lines = Object.values(active).map(s => {
      const params = Object.entries(s.parameters || {})
        .map(([k, v]) => `${k}${v.required ? '' : '?'}: ${v.type}`)
        .join(", ");
      return `- **${s.name}** (${s.category}): ${s.description}${params ? ` | params: {${params}}` : ''}`;
    });
    return lines.join("\n");
  }

  // ── List semua skill untuk display ────────────────────────────────────
  async listSkills(userId) {
    const data = await this.loadSkills(userId);
    const disabled = data?.disabled || [];
    const custom = data?.custom || {};
    const all = { ...this.builtinSkills, ...custom };

    return Object.values(all).map(s => ({
      ...s,
      active: !disabled.includes(s.name)
    }));
  }
}

module.exports = { SkillRegistry };
