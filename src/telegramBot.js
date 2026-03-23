// Telegram Bot menggunakan grammy — modern, zero vulns
const { Bot } = require("grammy");
const { AIAgent } = require("./agent");

const OWNER_ID = process.env.TELEGRAM_OWNER_ID
  ? parseInt(process.env.TELEGRAM_OWNER_ID)
  : null;

const userState = new Map();
const activeSessions = new Map();

function isAuthorized(userId) {
  if (!OWNER_ID) return true;
  return userId === OWNER_ID;
}
function getSession(uid) { return activeSessions.get(String(uid)); }
function setSession(uid, sid) { activeSessions.set(String(uid), sid); }
function newSession(uid) {
  const sid = `tg_${Date.now()}`;
  setSession(uid, sid);
  return sid;
}
function escMd(text) {
  return String(text).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
}
function splitMessage(text, maxLen = 4000) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  for (let i = 0; i < text.length; i += maxLen) chunks.push(text.slice(i, i + maxLen));
  return chunks;
}

async function createBot(agent, monitor = null) {
  const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);

  const guard = (ctx) => {
    if (!isAuthorized(ctx.from?.id)) {
      ctx.reply("⛔ Akses ditolak.").catch(() => {});
      return false;
    }
    return true;
  };


  // ── /addwallet ────────────────────────────────────────────────────────
  bot.command("addwallet", async (ctx) => {
    if (!guard(ctx)) return;
    if (!monitor) return ctx.reply("❌ Monitor tidak aktif.");
    const args  = (ctx.match || "").trim().split(/\s+/);
    const addr  = args[0] || "";
    const label = args.slice(1).join(" ") || null;
    if (!addr.startsWith("0x") || addr.length !== 42) {
      return ctx.reply("❌ Format salah. Contoh:\n/addwallet 0x123...abc NamaOrang");
    }
    const added = monitor.addWallet(addr, label);
    if (added) {
      await ctx.reply(
        `✅ Wallet ditambahkan!\n\n👛 ${addr}\n🏷 Label: ${label || "tidak ada"}\n\nNotif mint/sale akan dikirim otomatis.`
      );
    } else {
      await ctx.reply(`⚠️ Wallet ${addr} sudah ada di monitor.`);
    }
  });

  // ── /removewallet ─────────────────────────────────────────────────────
  bot.command("removewallet", async (ctx) => {
    if (!guard(ctx)) return;
    if (!monitor) return ctx.reply("❌ Monitor tidak aktif.");
    const addr = (ctx.match || "").trim();
    if (!addr) return ctx.reply("Usage: /removewallet 0x...");
    const removed = monitor.removeWallet(addr);
    await ctx.reply(removed
      ? `✅ Wallet ${addr} dihapus dari monitor.`
      : `❌ Wallet tidak ditemukan di monitor.`
    );
  });

  // ── /listwallet ───────────────────────────────────────────────────────
  bot.command("listwallet", async (ctx) => {
    if (!guard(ctx)) return;
    if (!monitor) return ctx.reply("❌ Monitor tidak aktif.");
    const wallets = monitor.listWallets();
    if (wallets.length === 0) return ctx.reply("Tidak ada wallet yang dipantau.");
    let msg = "👁 Wallet yang Dipantau:\n\n";
    wallets.forEach((w, i) => {
      const label = w.label ? ` — ${w.label}` : "";
      msg += `${i+1}. ${w.address}${label}\n`;
    });
    msg += `\nTotal: ${wallets.length} wallet`;
    msg += "\n\nKetik /addwallet 0x... NamaLabel untuk tambah";
    await ctx.reply(msg);
  });

  bot.command("start", async (ctx) => {
    if (!guard(ctx)) return;
    newSession(ctx.from.id);
    await ctx.reply(
      `🤖 *AI Agent v2\\.0 siap\\!*\n\nAgent AI dengan skill system dinamis\\.\n\n` +
      `*Perintah:*\n` +
      `• Kirim pesan biasa → agent otomatis pilih & jalankan skill\n` +
      `• /skills — lihat semua skill\n` +
      `• /addskill — tambah skill baru \\(wizard\\)\n` +
      `• /delskill \\<nama\\> — hapus custom skill\n` +
      `• /enableskill \\<nama\\> — aktifkan skill\n` +
      `• /disableskill \\<nama\\> — nonaktifkan skill\n` +
      `• /newsession — mulai sesi baru\n` +
      `• /memory — statistik memori\n` +
      `• /clearmemory — hapus semua memori\n` +
      `• /help — bantuan lengkap\n\n` +
      `Coba: _"cari berita terbaru AI"_ atau _"hitung 2 pangkat 10"_`,
      { parse_mode: "MarkdownV2" }
    );
  });

  bot.command("help", async (ctx) => {
    if (!guard(ctx)) return;
    await ctx.reply(
      `📖 *Panduan AI Agent*\n\n` +
      `*Skill bawaan:*\n` +
      `🔍 \`web\\_search\` — cari info internet\n` +
      `⚙️ \`code\\_runner\` — jalankan kode JS\n` +
      `🔗 \`http\\_request\` — panggil API eksternal\n` +
      `📝 \`text\\_transform\` — translate/ringkas/ekstrak\n` +
      `⏰ \`reminder\` — set pengingat\n` +
      `🎨 \`image\\_generate\` — buat prompt gambar AI\n\n` +
      `*Contoh:*\n` +
      `• "Cari harga Bitcoin hari ini"\n` +
      `• "Hitung luas lingkaran r\\=15"\n` +
      `• "Terjemahkan: Good morning"\n` +
      `• "Ingatkan saya 10 menit lagi"\n` +
      `• "Ringkas teks ini: \\.\\.\\."\n\n` +
      `*Custom skill:*\n` +
      `/addskill → wizard step\\-by\\-step\n` +
      `/delskill nama → hapus\n` +
      `/enableskill nama → aktifkan\n` +
      `/disableskill nama → nonaktifkan`,
      { parse_mode: "MarkdownV2" }
    );
  });

  bot.command("skills", async (ctx) => {
    if (!guard(ctx)) return;
    await ctx.replyWithChatAction("typing");
    try {
      const skills = await agent.listSkills(String(ctx.from.id));
      const byCategory = {};
      skills.forEach(s => {
        const c = s.category || "other";
        if (!byCategory[c]) byCategory[c] = [];
        byCategory[c].push(s);
      });
      const catEmoji = { research:"🔍",compute:"⚙️",integration:"🔗",text:"📝",productivity:"📅",creative:"🎨",custom:"🧩",other:"📦" };
      let lines = ["🛠 *Daftar Skill Agent*\n"];
      for (const [cat, catSkills] of Object.entries(byCategory)) {
        lines.push(`${catEmoji[cat]||"📦"} *${escMd(cat.toUpperCase())}*`);
        catSkills.forEach(s => {
          lines.push(`${s.active?"✅":"⛔"} \`${escMd(s.name)}\`${s.builtin?"":" \\[custom\\]"}`);
          lines.push(`    ${escMd(s.description.substring(0,70))}`);
        });
        lines.push("");
      }
      lines.push(`_Total: ${skills.length} skill_`);
      await ctx.reply(lines.join("\n"), { parse_mode: "MarkdownV2" });
    } catch (e) { await ctx.reply(`❌ Error: ${e.message}`); }
  });

  bot.command("addskill", async (ctx) => {
    if (!guard(ctx)) return;
    userState.set(String(ctx.from.id), { step: "addskill_name", data: {} });
    await ctx.reply(
      `🧩 *Tambah Skill Baru* \\(1/4\\)\n\nMasukkan *nama skill*:\n_huruf kecil \\+ underscore, contoh: \`cek\\_cuaca\`_`,
      { parse_mode: "MarkdownV2" }
    );
  });

  bot.command("delskill", async (ctx) => {
    if (!guard(ctx)) return;
    const name = ctx.match?.trim();
    if (!name) return ctx.reply("Usage: /delskill <nama_skill>");
    try {
      const ok = await agent.removeSkill(String(ctx.from.id), name);
      await ctx.reply(ok
        ? `✅ Skill \`${escMd(name)}\` dihapus\\.`
        : `❌ Skill \`${escMd(name)}\` tidak ditemukan\\.`,
        { parse_mode: "MarkdownV2" }
      );
    } catch (e) { await ctx.reply(`❌ ${e.message}`); }
  });

  bot.command("enableskill", async (ctx) => {
    if (!guard(ctx)) return;
    const name = ctx.match?.trim();
    if (!name) return ctx.reply("Usage: /enableskill <nama_skill>");
    await agent.toggleSkill(String(ctx.from.id), name, true);
    await ctx.reply(`✅ Skill \`${escMd(name)}\` diaktifkan\\.`, { parse_mode: "MarkdownV2" });
  });

  bot.command("disableskill", async (ctx) => {
    if (!guard(ctx)) return;
    const name = ctx.match?.trim();
    if (!name) return ctx.reply("Usage: /disableskill <nama_skill>");
    await agent.toggleSkill(String(ctx.from.id), name, false);
    await ctx.reply(`⛔ Skill \`${escMd(name)}\` dinonaktifkan\\.`, { parse_mode: "MarkdownV2" });
  });

  bot.command("newsession", async (ctx) => {
    if (!guard(ctx)) return;
    const sid = newSession(ctx.from.id);
    await ctx.reply(`✅ Sesi baru dimulai\\.\nID: \`${escMd(sid)}\``, { parse_mode: "MarkdownV2" });
  });

  bot.command("memory", async (ctx) => {
    if (!guard(ctx)) return;
    try {
      const s = await agent.getMemorySummary(String(ctx.from.id));
      const sid = getSession(ctx.from.id) || "belum ada";
      await ctx.reply(
        `🧠 *Ringkasan Memori*\n\nUser ID: \`${escMd(String(ctx.from.id))}\`\nTotal sesi: ${s.totalSessions}\nTotal pesan: ${s.totalMessages}\nSesi aktif: \`${escMd(sid)}\``,
        { parse_mode: "MarkdownV2" }
      );
    } catch (e) { await ctx.reply(`❌ ${e.message}`); }
  });

  bot.command("clearmemory", async (ctx) => {
    if (!guard(ctx)) return;
    await agent.clearMemory(String(ctx.from.id));
    newSession(ctx.from.id);
    await ctx.reply("🗑 Memori dihapus\\. Sesi baru dimulai\\.", { parse_mode: "MarkdownV2" });
  });

  // ── Main message handler ─────────────────────────────────────────────
  bot.on("message:text", async (ctx) => {
    if (ctx.message.text.startsWith("/")) return;
    if (!guard(ctx)) return;
    const userId = String(ctx.from.id);

    // Wizard
    const state = userState.get(userId);
    if (state) {
      await handleWizard(ctx, state, userId, agent);
      return;
    }

    // AI Chat
    let session = getSession(ctx.from.id);
    if (!session) session = newSession(ctx.from.id);

    await ctx.replyWithChatAction("typing");
    const typingInterval = setInterval(() => ctx.replyWithChatAction("typing").catch(()=>{}), 4000);

    try {
      const result = await agent.process(userId, ctx.message.text, session, async (msg) => {
        await ctx.reply(msg, { parse_mode: "Markdown" });
      });
      clearInterval(typingInterval);
      setSession(ctx.from.id, result.sessionId);

      let reply = result.response;
      if (result.skillsUsed?.length > 0) {
        const used = result.skillsUsed.map(s => `${s.success?"✅":"❌"} ${s.skill}`).join(" · ");
        reply += `\n\n_🔧 ${used}_`;
      }
      for (const chunk of splitMessage(reply, 4000)) {
        await ctx.reply(chunk, { parse_mode: "Markdown" }).catch(() => ctx.reply(chunk));
      }
    } catch (err) {
      clearInterval(typingInterval);
      console.error("Agent error:", err.message);
      await ctx.reply(`❌ *Error:* ${err.message}`, { parse_mode: "Markdown" });
    }
  });

  bot.catch((err) => console.error("Bot error:", err.message));
  return bot;
}

// ── Wizard ────────────────────────────────────────────────────────────────
async function handleWizard(ctx, state, userId, agent) {
  const text = ctx.message.text.trim();

  if (state.step === "addskill_name") {
    if (!/^[a-z][a-z0-9_]{1,30}$/.test(text)) {
      return ctx.reply("❌ Nama tidak valid. Gunakan huruf kecil & underscore. Contoh: cek_cuaca");
    }
    state.data.name = text;
    state.step = "addskill_desc";
    userState.set(userId, state);
    return ctx.reply(`🧩 Tambah Skill (2/4)\n\nSkill: ${text}\n\nMasukkan deskripsi singkat (apa yang dilakukan skill ini):`);
  }
  if (state.step === "addskill_desc") {
    state.data.description = text;
    state.step = "addskill_type";
    userState.set(userId, state);
    return ctx.reply(`🧩 Tambah Skill (3/4)\n\nPilih tipe eksekusi:\n\n1️⃣ llm — Agent AI proses dengan instruksimu\n2️⃣ webhook — Kirim POST ke URL/API kamu\n\nBalas dengan: llm atau webhook`);
  }
  if (state.step === "addskill_type") {
    const t = text.toLowerCase();
    if (!["llm","webhook"].includes(t)) return ctx.reply("❌ Pilih llm atau webhook");
    state.data.type = t;
    state.step = t === "llm" ? "addskill_instruction" : "addskill_webhook";
    userState.set(userId, state);
    if (t === "llm") return ctx.reply(`🧩 Tambah Skill (4/4)\n\nMasukkan instruksi untuk agent:\n\nContoh: "Analisa sentimen teks yang diberikan dan beri skor 1-10 beserta alasannya"`);
    return ctx.reply(`🧩 Tambah Skill (4/4)\n\nMasukkan URL webhook:\n\nAgent akan POST request ke URL ini dengan parameter dari user. Format: { skill, params, timestamp }`);
  }
  if (state.step === "addskill_instruction") {
    state.data.instruction = text;
    return finishAddSkill(ctx, userId, state.data, agent);
  }
  if (state.step === "addskill_webhook") {
    if (!text.startsWith("http")) return ctx.reply("❌ URL harus dimulai dengan http:// atau https://");
    state.data.webhook_url = text;
    return finishAddSkill(ctx, userId, state.data, agent);
  }
}

async function finishAddSkill(ctx, userId, data, agent) {
  userState.delete(userId);
  try {
    const skill = await agent.addSkill(userId, {
      name: data.name,
      description: data.description,
      category: "custom",
      instruction: data.instruction || null,
      webhook_url: data.webhook_url || null,
      examples: []
    });
    await ctx.reply(
      `✅ Skill berhasil ditambahkan!\n\nNama: ${skill.name}\nTipe: ${data.type}\nDeskripsi: ${skill.description}\n\nAgent sekarang bisa menggunakan skill ini secara otomatis. Coba kirim pesan yang membutuhkan skill ini!`
    );
  } catch (e) {
    await ctx.reply(`❌ Gagal: ${e.message}`);
  }
}

module.exports = { createBot };
