require("dotenv").config();
const express = require("express");
const { createBot }      = require("./telegramBot");
const { AIAgent }        = require("./agent");
const { GitHubMemory }   = require("./memory");
const { OpenSeaMonitor } = require("./opensea_monitor");
const { MineLootMiner }  = require("./mineloot_miner");

// Validasi provider-aware
const provider = (process.env.LLM_PROVIDER || "qwen").toLowerCase();
const providerKeyMap = {
  gemini: "GEMINI_API_KEY",
  qwen:   "DASHSCOPE_API_KEY",
  openai: "OPENAI_API_KEY",
  custom: "CUSTOM_API_KEY",
};
const requiredLLMKey = providerKeyMap[provider] || "DASHSCOPE_API_KEY";

const required = [
  "TELEGRAM_BOT_TOKEN",
  requiredLLMKey,
  "GITHUB_TOKEN",
  "GITHUB_OWNER",
  "GITHUB_REPO",
  "TELEGRAM_OWNER_ID",
];

const missing = required.filter(k => !process.env[k]);
if (missing.length > 0) {
  console.error(`❌ Missing env vars: ${missing.join(", ")}`);
  process.exit(1);
}

async function main() {
  console.log("🚀 Starting Telegram AI Agent...");
  console.log(`📡 Provider: ${provider} | Model: ${process.env.MODEL_NAME || "auto"}`);
  console.log(`💾 Memory: GitHub (${process.env.GITHUB_OWNER}/${process.env.GITHUB_REPO})`);

  const memory = new GitHubMemory();
  await memory.ensureRepoSetup();

  const agent = new AIAgent();
  const bot   = await createBot(agent);
  bot.start();
  console.log("🤖 Telegram bot started (long polling)");

  const OWNER_CHAT_ID = process.env.TELEGRAM_OWNER_ID;

  const sendMsg = async (msg) => {
    try {
      await bot.api.sendMessage(OWNER_CHAT_ID, msg, { parse_mode: "Markdown" });
    } catch (e) {
      console.error("Send msg failed:", e.message);
    }
  };

  // ── OpenSea Monitor (silent — notif hanya kalau ada mint/sale) ─────────
  const opensea = new OpenSeaMonitor(sendMsg);
  opensea.start();

  // ── MineLoot Miner (aktif hanya kalau MINING_ENABLED=true) ────────────
  const miner = new MineLootMiner(sendMsg);
  await miner.start();

  // ── Express health check ───────────────────────────────────────────────
  const app = express();
  app.get("/", (_, res) => res.json({
    status: "ok",
    provider,
    opensea_monitor: opensea.isRunning,
    mineloot_miner: miner.isRunning,
    miner_wallet: miner.walletAddress,
    uptime: process.uptime()
  }));
  app.get("/health", (_, res) => res.json({
    status: "ok",
    provider,
    model: process.env.MODEL_NAME || "auto",
    opensea_monitor: opensea.isRunning,
    mineloot_miner: miner.isRunning,
  }));
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`✅ Health check server on port ${PORT}`));

  process.on("SIGTERM", async () => {
    console.log("Shutting down...");
    opensea.stop();
    miner.stop();
    await bot.stop();
    process.exit(0);
  });
}

main().catch(err => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
