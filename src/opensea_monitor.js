// OpenSea Monitor v4 — multi-source, robust event detection
const axios = require("axios");

const POLL_INTERVAL_MS = 30 * 1000; // cek setiap 30 detik (lebih sering)
const EVENT_TYPES      = ["mint", "sale"];

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
    this.apiKey           = process.env.OPENSEA_API_KEY || null;
    this.alchemyKey       = process.env.ALCHEMY_API_KEY || null;
    this.etherscanKey     = process.env.ETHERSCAN_API_KEY || null;
    this.startTime        = null;

    this.wallets    = getWalletList();
    this.labels     = getWalletLabels();
    // Simpan tx hash terakhir per wallet agar tidak double notif
    this.lastTxHash = {}; // wallet → Set of txHash
    this.wallets.forEach(w => { this.lastTxHash[w] = new Set(); });
    // Simpan timestamp start agar hanya notif event BARU
    this.startTimestamp = Math.floor(Date.now() / 1000);
  }

  start() {
    if (this.isRunning) return;
    this.isRunning      = true;
    this.startTime      = new Date();
    this.startTimestamp = Math.floor(Date.now() / 1000);
    console.log(`👁 OpenSea monitor v4 started — ${this.wallets.length} wallet(s)`);
    this.wallets.forEach(w => console.log(`  → ${w} (${this.labels[w] || "no label"})`));
    // Delay 10 detik sebelum poll pertama agar tidak fetch event lama
    setTimeout(() => {
      this._pollAll();
      this.pollTimer = setInterval(() => this._pollAll(), POLL_INTERVAL_MS);
    }, 10000);
  }

  stop() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.isRunning = false;
    console.log("🛑 OpenSea monitor stopped");
  }

  addWallet(address, label = null) {
    const addr = address.toLowerCase();
    if (this.wallets.includes(addr)) return false;
    this.wallets.push(addr);
    this.lastTxHash[addr] = new Set();
    if (label) this.labels[addr] = label;
    console.log(`👁 Added wallet: ${addr} (${label || "no label"})`);
    return true;
  }

  removeWallet(address) {
    const addr = address.toLowerCase();
    const idx  = this.wallets.indexOf(addr);
    if (idx === -1) return false;
    this.wallets.splice(idx, 1);
    delete this.lastTxHash[addr];
    delete this.labels[addr];
    return true;
  }

  listWallets() {
    return this.wallets.map(w => ({
      address: w,
      label:   this.labels[w] || null,
    }));
  }

  async _pollAll() {
    for (const wallet of this.wallets) {
      try {
        await this._pollWallet(wallet);
      } catch (e) {
        console.error(`Poll error [${wallet.slice(0,8)}]:`, e.message);
      }
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  async _pollWallet(wallet) {
    // Coba multiple sumber, pakai yang pertama berhasil
    let events = [];

    // Sumber 1: OpenSea API v2
    if (!events.length) events = await this._fetchOpenSea(wallet);

    // Sumber 2: Etherscan NFT transfers (free, no key needed tapi terbatas)
    if (!events.length) events = await this._fetchEtherscan(wallet);

    // Sumber 3: Alchemy NFT API
    if (!events.length && this.alchemyKey) events = await this._fetchAlchemy(wallet);

    if (!events.length) return;

    const seen  = this.lastTxHash[wallet];
    const newEv = events.filter(e => {
      const id = e.txHash || e.id || `${e.type}-${e.tokenId}-${e.timestamp}`;
      if (seen.has(id)) return false;
      // Hanya event setelah bot start
      if (e.timestamp && e.timestamp < this.startTimestamp) {
        seen.add(id); // mark as seen tapi jangan notif
        return false;
      }
      seen.add(id);
      if (seen.size > 1000) {
        const first = seen.values().next().value;
        seen.delete(first);
      }
      return true;
    });

    for (const event of newEv) {
      const msg = this._formatEvent(event, wallet);
      if (msg) {
        try { await this.sendNotification(msg); }
        catch (e) { console.error("Notify failed:", e.message); }
      }
    }
  }

  // ── Source 1: OpenSea API v2 ───────────────────────────────────────────
  async _fetchOpenSea(wallet) {
    try {
      const headers = { "accept": "application/json" };
      if (this.apiKey) headers["x-api-key"] = this.apiKey;

      const res = await axios.get(
        `https://api.opensea.io/api/v2/events/accounts/${wallet}`,
        { params: { event_type: EVENT_TYPES, limit: 20 }, headers, timeout: 10000 }
      );
      const raw = res.data?.asset_events || [];
      return raw.map(e => ({
        source:    "opensea",
        type:      e.event_type,
        id:        e.id,
        txHash:    e.transaction,
        timestamp: e.event_timestamp ? new Date(e.event_timestamp).getTime()/1000 : null,
        nftName:   e.nft?.name || e.nft?.identifier || "Unknown NFT",
        collection: e.nft?.collection?.name || "Unknown Collection",
        link:       e.nft?.permalink || `https://opensea.io/${wallet}/activity`,
        priceETH:   e.payment ? (Number(e.payment.quantity) / 1e18).toFixed(4) : null,
        priceSym:   e.payment?.symbol || "ETH",
        quantity:   e.quantity || 1,
      }));
    } catch (e) {
      if (e.response?.status === 429) console.warn("OpenSea rate limit");
      else if (e.response?.status !== 401 && e.response?.status !== 403)
        console.error("OpenSea fetch error:", e.message);
      return [];
    }
  }

  // ── Source 2: Etherscan NFT Transfers ─────────────────────────────────
  async _fetchEtherscan(wallet) {
    try {
      const params = {
        module: "account", action: "tokennfttx",
        address: wallet,
        page: 1, offset: 20, sort: "desc",
        ...(this.etherscanKey ? { apikey: this.etherscanKey } : {})
      };
      const res = await axios.get("https://api.etherscan.io/api", { params, timeout: 10000 });
      if (res.data?.status !== "1" || !Array.isArray(res.data?.result)) return [];

      const now = Math.floor(Date.now() / 1000);
      return res.data.result
        .filter(tx => (now - parseInt(tx.timeStamp)) < 3600) // hanya 1 jam terakhir
        .map(tx => {
          const isMint = tx.from === "0x0000000000000000000000000000000000000000";
          const type   = isMint ? "mint" : (tx.to.toLowerCase() === wallet ? "received" : "sale");
          if (!["mint", "sale"].includes(type) && tx.to.toLowerCase() !== wallet) return null;
          return {
            source:     "etherscan",
            type:       isMint ? "mint" : "sale",
            txHash:     tx.hash,
            id:         tx.hash,
            timestamp:  parseInt(tx.timeStamp),
            nftName:    tx.tokenName || "Unknown NFT",
            collection: tx.tokenName || "Unknown Collection",
            link:       `https://opensea.io/assets/ethereum/${tx.contractAddress}/${tx.tokenID}`,
            tokenId:    tx.tokenID,
            priceETH:   null,
            priceSym:   "ETH",
            quantity:   1,
          };
        }).filter(Boolean);
    } catch (e) {
      console.error("Etherscan fetch error:", e.message);
      return [];
    }
  }

  // ── Source 3: Alchemy NFT API ──────────────────────────────────────────
  async _fetchAlchemy(wallet) {
    if (!this.alchemyKey) return [];
    try {
      const res = await axios.get(
        `https://eth-mainnet.g.alchemy.com/nft/v3/${this.alchemyKey}/getNFTsForOwner`,
        { params: { owner: wallet, withMetadata: false, pageSize: 20 }, timeout: 10000 }
      );
      // Alchemy tidak langsung return events, skip untuk sekarang
      return [];
    } catch (e) { return []; }
  }

  _formatEvent(event, wallet) {
    const type   = event.type;
    const label  = this.labels[wallet] || null;
    const wDisp  = label
      ? `*${escMd(label)}* (\`${wallet.slice(0,6)}...${wallet.slice(-4)}\`)`
      : `\`${wallet.slice(0,8)}...${wallet.slice(-6)}\``;
    const time   = new Date().toLocaleString("id-ID", {
      timeZone: "Asia/Jakarta", day: "2-digit", month: "short",
      hour: "2-digit", minute: "2-digit"
    });
    const qty    = event.quantity > 1 ? ` (x${event.quantity})` : "";

    if (type === "mint") {
      return (
        `🌟 *MINT TERDETEKSI!*\n\n` +
        `👛 Wallet: ${wDisp}\n` +
        `🎨 NFT: *${escMd(event.nftName)}*${qty}\n` +
        `📦 Koleksi: ${escMd(event.collection)}\n` +
        `🔗 [Lihat di OpenSea](${event.link})\n` +
        `🕐 ${escMd(time)}`
      );
    }
    if (type === "sale") {
      const price = event.priceETH ? `${event.priceETH} ${event.priceSym}` : "N/A";
      return (
        `💰 *SALE TERDETEKSI!*\n\n` +
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
}

function escMd(text) {
  return String(text || "").replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
}

module.exports = { OpenSeaMonitor };
