// OpenSea Monitor v5 — heartbeat 1 jam + notif instan mint/sale
const axios = require("axios");

const POLL_INTERVAL_MS      = 30 * 1000;       // cek event setiap 30 detik
const HEARTBEAT_INTERVAL_MS = 60 * 60 * 1000; // heartbeat setiap 1 jam

function getWalletList() {
  const defaults = ["0x806eca4d9e4cebea43df3d0fbb4867aa59422c7a"];
  const fromEnv  = process.env.OPENSEA_WALLETS
    ? process.env.OPENSEA_WALLETS.split(",").map(w => w.trim().toLowerCase()).filter(Boolean)
    : [];
  return [...new Set([...defaults, ...fromEnv])];
}

function getWalletLabels() {
  const labels = {};
  if (process.env.OPENSEA_WALLET_LABELS) {
    process.env.OPENSEA_WALLET_LABELS.split(",").forEach(pair => {
      const [addr, name] = pair.split("=");
      if (addr && name) labels[addr.trim().toLowerCase()] = name.trim();
    });
  }
  return labels;
}

class OpenSeaMonitor {
  constructor(sendNotification) {
    this.sendNotification = sendNotification;
    this.isRunning        = false;
    this.pollTimer        = null;
    this.heartbeatTimer   = null;
    this.apiKey           = process.env.OPENSEA_API_KEY   || null;
    this.etherscanKey     = process.env.ETHERSCAN_API_KEY || null;
    this.alchemyKey       = process.env.ALCHEMY_API_KEY   || null;
    this.startTime        = null;
    this.totalNotifs      = 0;
    this.pollCount        = 0;

    this.wallets        = getWalletList();
    this.labels         = getWalletLabels();
    this.seenTxHashes   = {};
    this.wallets.forEach(w => { this.seenTxHashes[w] = new Set(); });
    this.startTimestamp = Math.floor(Date.now() / 1000);
  }

  async start() {
    if (this.isRunning) return;
    this.isRunning      = true;
    this.startTime      = new Date();
    this.startTimestamp = Math.floor(Date.now() / 1000);

    console.log(`👁 OpenSea monitor v5 started — ${this.wallets.length} wallet(s)`);
    this.wallets.forEach(w => console.log(`  → ${w} (${this.labels[w] || "no label"})`));

    // Notif start — konfirmasi monitor aktif
    const walletLines = this.wallets.map((w, i) => {
      const label = this.labels[w] ? ` — ${this.labels[w]}` : "";
      return `${i+1}\\. \`${w.slice(0,8)}\\.\\.\\. ${w.slice(-6)}\`${label}`;
    }).join("\n");

    await this._notify(
      `👁 *OpenSea Monitor AKTIF*\n\n` +
      `✅ Memantau ${this.wallets.length} wallet:\n${walletLines}\n\n` +
      `⏱ Cek setiap: 30 detik\n` +
      `💓 Heartbeat: setiap 1 jam\n` +
      `🕐 Mulai: ${this._timeNow()}`
    );

    // Inisiasi seen hashes dari event yang sudah ada (jangan notif yang lama)
    await this._initSeenHashes();

    // Start polling
    this.pollTimer = setInterval(() => this._pollAll(), POLL_INTERVAL_MS);

    // Heartbeat setiap 1 jam
    this.heartbeatTimer = setInterval(() => this._sendHeartbeat(), HEARTBEAT_INTERVAL_MS);
  }

  stop() {
    if (this.pollTimer)      clearInterval(this.pollTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.isRunning = false;
    console.log("🛑 OpenSea monitor stopped");
  }

  addWallet(address, label = null) {
    const addr = address.toLowerCase();
    if (this.wallets.includes(addr)) return false;
    this.wallets.push(addr);
    this.seenTxHashes[addr] = new Set();
    if (label) this.labels[addr] = label;
    console.log(`👁 Added wallet: ${addr}`);
    return true;
  }

  removeWallet(address) {
    const addr = address.toLowerCase();
    const idx  = this.wallets.indexOf(addr);
    if (idx === -1) return false;
    this.wallets.splice(idx, 1);
    delete this.seenTxHashes[addr];
    delete this.labels[addr];
    return true;
  }

  listWallets() {
    return this.wallets.map(w => ({ address: w, label: this.labels[w] || null }));
  }

  // ── Init: tandai semua event yang sudah ada sebagai "seen" ────────────
  async _initSeenHashes() {
    console.log("👁 Initializing seen hashes (marking old events)...");
    for (const wallet of this.wallets) {
      try {
        const events = await this._fetchAllSources(wallet);
        events.forEach(e => {
          const id = e.txHash || e.id;
          if (id) this.seenTxHashes[wallet].add(id);
        });
        console.log(`  → ${wallet.slice(0,8)}: ${this.seenTxHashes[wallet].size} old events marked`);
      } catch (e) {
        console.error(`Init error [${wallet.slice(0,8)}]:`, e.message);
      }
      await new Promise(r => setTimeout(r, 1000));
    }
    console.log("✅ Init done — siap deteksi event baru");
  }

  // ── Heartbeat setiap 1 jam ────────────────────────────────────────────
  async _sendHeartbeat() {
    const uptime = this._uptime();
    const walletLines = this.wallets.map((w, i) => {
      const label = this.labels[w] ? ` — ${this.labels[w]}` : "";
      return `${i+1}\\. \`${w.slice(0,8)}\\.\\.\\. ${w.slice(-6)}\`${label}`;
    }).join("\n");

    await this._notify(
      `💓 *OpenSea Monitor masih aktif*\n\n` +
      `✅ Status: Online & memantau\n` +
      `📊 Wallet dipantau:\n${walletLines}\n\n` +
      `⏱ Uptime: ${uptime}\n` +
      `🔍 Total poll: ${this.pollCount}x\n` +
      `🔔 Total notif terkirim: ${this.totalNotifs}x\n` +
      `🕐 ${this._timeNow()}`
    );
  }

  // ── Poll semua wallet ────────────────────────────────────────────────
  async _pollAll() {
    this.pollCount++;
    for (const wallet of this.wallets) {
      try {
        await this._pollWallet(wallet);
      } catch (e) {
        console.error(`Poll error [${wallet.slice(0,8)}]:`, e.message);
      }
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  async _pollWallet(wallet) {
    const events = await this._fetchAllSources(wallet);
    if (!events.length) return;

    const seen   = this.seenTxHashes[wallet];
    const newEv  = events.filter(e => {
      const id = e.txHash || e.id || `${e.type}-${e.nftName}-${e.timestamp}`;
      if (seen.has(id)) return false;
      seen.add(id);
      if (seen.size > 2000) {
        const first = seen.values().next().value;
        seen.delete(first);
      }
      return true;
    });

    for (const event of newEv) {
      const msg = this._formatEvent(event, wallet);
      if (msg) {
        console.log(`🔔 New ${event.type} event for ${wallet.slice(0,8)}: ${event.nftName}`);
        try {
          await this.sendNotification(msg);
          this.totalNotifs++;
        } catch (e) {
          console.error("Notify failed:", e.message);
        }
      }
    }
  }

  // ── Fetch dari semua sumber, return yang pertama berhasil ─────────────
  async _fetchAllSources(wallet) {
    // Coba OpenSea dulu
    let events = await this._fetchOpenSea(wallet);
    if (events.length > 0) return events;

    // Fallback Etherscan
    events = await this._fetchEtherscan(wallet);
    if (events.length > 0) return events;

    return [];
  }

  // ── OpenSea API v2 ────────────────────────────────────────────────────
  async _fetchOpenSea(wallet) {
    try {
      const headers = { "accept": "application/json" };
      if (this.apiKey) headers["x-api-key"] = this.apiKey;
      const res = await axios.get(
        `https://api.opensea.io/api/v2/events/accounts/${wallet}`,
        { params: { event_type: ["mint", "sale"], limit: 20 }, headers, timeout: 10000 }
      );
      return (res.data?.asset_events || []).map(e => ({
        source:     "opensea",
        type:       e.event_type,
        id:         String(e.id || ""),
        txHash:     e.transaction || "",
        timestamp:  e.event_timestamp ? new Date(e.event_timestamp).getTime()/1000 : 0,
        nftName:    e.nft?.name || `#${e.nft?.identifier}` || "Unknown NFT",
        collection: e.nft?.collection?.name || "Unknown Collection",
        link:       e.nft?.permalink || `https://opensea.io/${wallet}/activity`,
        priceETH:   e.payment ? (Number(e.payment.quantity)/1e18).toFixed(4) : null,
        priceSym:   e.payment?.symbol || "ETH",
        quantity:   e.quantity || 1,
      }));
    } catch (e) {
      if (e.response?.status === 429) console.warn(`⚠️ OpenSea rate limit [${wallet.slice(0,8)}]`);
      return [];
    }
  }

  // ── Etherscan NFT Transfers (fallback) ────────────────────────────────
  async _fetchEtherscan(wallet) {
    try {
      const res = await axios.get("https://api.etherscan.io/api", {
        params: {
          module: "account", action: "tokennfttx",
          address: wallet, page: 1, offset: 20, sort: "desc",
          ...(this.etherscanKey ? { apikey: this.etherscanKey } : {})
        },
        timeout: 10000
      });
      if (res.data?.status !== "1" || !Array.isArray(res.data?.result)) return [];

      const now = Math.floor(Date.now() / 1000);
      return res.data.result
        .filter(tx => (now - parseInt(tx.timeStamp)) < 7200) // 2 jam terakhir
        .map(tx => {
          const isMint = tx.from === "0x0000000000000000000000000000000000000000";
          const toMe   = tx.to.toLowerCase() === wallet.toLowerCase();
          if (!isMint && !toMe) return null;
          return {
            source:     "etherscan",
            type:       isMint ? "mint" : "sale",
            id:         tx.hash,
            txHash:     tx.hash,
            timestamp:  parseInt(tx.timeStamp),
            nftName:    `${tx.tokenName} #${tx.tokenID}` || "Unknown NFT",
            collection: tx.tokenName || "Unknown",
            link:       `https://opensea.io/assets/ethereum/${tx.contractAddress}/${tx.tokenID}`,
            priceETH:   null,
            priceSym:   "ETH",
            quantity:   1,
          };
        }).filter(Boolean);
    } catch (e) {
      console.error(`Etherscan error [${wallet.slice(0,8)}]:`, e.message);
      return [];
    }
  }

  // ── Format notif ──────────────────────────────────────────────────────
  _formatEvent(event, wallet) {
    const label = this.labels[wallet] || null;
    const short = wallet.slice(0,8) + "..." + wallet.slice(-6);
    const wDisp = label
      ? "*" + escMd(label) + "* (`" + wallet.slice(0,6) + "..." + wallet.slice(-4) + "`)"
      : "`" + short + "`";
    const time  = this._timeNow();
    const qty   = event.quantity > 1 ? ` \\(x${event.quantity}\\)` : "";

    if (event.type === "mint") {
      return (
        `🌟 *MINT TERDETEKSI\\!*\n\n` +
        `👛 Wallet: ${wDisp}\n` +
        `🎨 NFT: *${escMd(event.nftName)}*${qty}\n` +
        `📦 Koleksi: ${escMd(event.collection)}\n` +
        `🔗 [Lihat di OpenSea](${event.link})\n` +
        `🕐 ${escMd(time)}`
      );
    }
    if (event.type === "sale") {
      const price = event.priceETH ? `${event.priceETH} ${event.priceSym}` : "N/A";
      return (
        `💰 *SALE TERDETEKSI\\!*\n\n` +
        `👛 Wallet: ${wDisp}\n` +
        `🎨 NFT: *${escMd(event.nftName)}*${qty}\n` +
        `📦 Koleksi: ${escMd(event.collection)}\n` +
        `💵 Harga: ${escMd(price)}\n` +
        `🔗 [Lihat di OpenSea](${event.link})\n` +
        `🕐 ${escMd(time)}`
      );
    }
    return null;
  }

  async _notify(msg) {
    try { await this.sendNotification(msg); }
    catch (e) { console.error("Notify failed:", e.message); }
  }

  _timeNow() {
    return new Date().toLocaleString("id-ID", {
      timeZone: "Asia/Jakarta",
      day: "2-digit", month: "short", year: "numeric",
      hour: "2-digit", minute: "2-digit"
    });
  }

  _uptime() {
    if (!this.startTime) return "0 menit";
    const ms = Date.now() - this.startTime.getTime();
    const h  = Math.floor(ms / 3600000);
    const m  = Math.floor((ms % 3600000) / 60000);
    return h > 0 ? `${h} jam ${m} menit` : `${m} menit`;
  }
}

function escMd(text) {
  return String(text || "").replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
}

module.exports = { OpenSeaMonitor };
