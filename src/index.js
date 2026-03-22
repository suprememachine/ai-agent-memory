require("dotenv").config();
const express = require("express");
const { createBot } = require("./telegramBot");
const { AIAgent } = require("./agent");
const { GitHubMemory } = require("./memory");

// Validasi provider-aware: cek API key sesuai LLM_PROVIDER yang dipilih
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
  "GITHUB_REPO"
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

  // Setup GitHub structure
  const memory = new GitHubMemory();
  await memory.ensureRepoSetup();

  // Init agent
  const agent = new AIAgent();

  // Start Telegram bot
  const bot = await createBot(agent);
  bot.start();
  console.log("🤖 Telegram bot started (long polling)");

  // Express health check — Railway requires HTTP listener
  const app = express();
  app.get("/", (_, res) => res.json({ status: "ok", service: "telegram-ai-agent", provider, uptime: process.uptime() }));
  app.get("/health", (_, res) => res.json({ status: "ok", provider, model: process.env.MODEL_NAME || "auto" }));
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`✅ Health check server on port ${PORT}`));

  process.on("SIGTERM", async () => {
    console.log("Shutting down...");
    await bot.stop();
    process.exit(0);
  });
}

main().catch(err => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
