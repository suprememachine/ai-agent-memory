// OpenSea Monitor — multi-wallet, notif HANYA kalau ada mint/sale
// Wallet list dari env OPENSEA_WALLETS (comma separated) + hardcoded default
const axios = require("axios");

const POLL_INTERVAL_MS = 60 * 1000;
const EVENT_TYPES      = ["mint", "sale"];

// ── Parse daftar wallet dari env ───────────────────────────────────────────
function getWalletList() {
  const defaults = ["0x806eca4d9e4cebea43df3d0fbb4867aa59422c7a"];
  const fromEnv  = process.env.OPENSEA_WALLETS
    ? process.env.OPENSEA_WALLETS.split(",").map(w => w.trim().toLowerCase()).filter(Boolean)
    : [];
  // Gabungkan default + dari env, hilangkan duplikat
  const all = [...new Set([...defaults, ...fromEnv])];
  return all;
}

// ── Label wallet (opsional, dari env OPENSEA_WALLET_LABELS) ───────────────
// Format: "0xabc=Alice,0xdef=Bob"
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
    this.startTime        = null;

    // Per-wallet state
    this.wallets          = getWalletList();
    this.labels           = getWalletLabels();
    this.seenEvents       = {}; // wallet → Set of event IDs
    this.wallets.forEach(w => { this.seenEvents[w] = new Set(); });
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.startTime = new Date();
    console.log(`👁 OpenSea monitor started — ${this.wallets.length} wallet(s):`, this.wallets);
    this._pollAll();
    this.pollTimer = setInterval(() => this._pollAll(), POLL_INTERVAL_MS);
  }

  stop() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.isRunning = false;
    console.log("🛑 OpenSea monitor stopped");
  }

  // ── Tambah wallet baru saat runtime ───────────────────────────────────
  addWallet(address, label = null) {
    const addr = address.toLowerCase();
    if (this.wallets.includes(addr)) return false;
    this.wallets.push(addr);
    this.seenEvents[addr] = new Set();
    if (label) this.labels[addr] = label;
    console.log(`👁 Added wallet to monitor: ${addr} (${label || "no label"})`);
    return true;
  }

  removeWallet(address) {
    const addr = address.toLowerCase();
    const idx  = this.wallets.indexOf(addr);
    if (idx === -1) return false;
    this.wallets.splice(idx, 1);
    delete this.seenEvents[addr];
    delete this.labels[addr];
    console.log(`👁 Removed wallet from monitor: ${addr}`);
    return true;
  }

  listWallets() {
    return this.wallets.map(w => ({
      address: w,
      label: this.labels[w] || null,
      seenEvents: this.seenEvents[w]?.size || 0,
    }));
  }

  // ── Poll semua wallet ─────────────────────────────────────────────────
  async _pollAll() {
    for (const wallet of this.wallets) {
      try {
        await this._pollWallet(wallet);
      } catch (e) {
        console.error(`OpenSea poll error [${wallet}]:`, e.message);
      }
      // Delay kecil antar wallet agar tidak rate limit
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  async _pollWallet(wallet) {
    const events = await this._fetchEvents(wallet);
    if (!events || events.length === 0) return;

    const seen = this.seenEvents[wallet];
    const newEvents = events.filter(e => {
      const id = e.id || `${e.event_type}-${e.transaction}-${wallet}`;
      if (seen.has(id)) return false;
      seen.add(id);
      if (seen.size > 500) {
        const first = seen.values().next().value;
        seen.delete(first);
      }
      return true;
    });

    for (const event of newEvents) {
      const msg = this._formatEvent(event, wallet);
      if (msg) {
        try { await this.sendNotification(msg); }
        catch (e) { console.error("Notify failed:", e.message); }
      }
    }
  }

  async _fetchEvents(wallet) {
    const url     = `https://api.opensea.io/api/v2/events/accounts/${wallet}`;
    const headers = {
      "accept": "application/json",
      ...(this.apiKey ? { "x-api-key": this.apiKey } : {}),
    };
    try {
      const res = await axios.get(url, {
        params: { event_type: EVENT_TYPES, limit: 20 },
        headers,
        timeout: 10000,
      });
      return res.data?.asset_events || [];
    } catch (err) {
      if (err.response?.status === 401 || err.response?.status === 403) {
        return await this._fetchFallback(wallet);
      }
      if (err.response?.status === 429) return [];
      throw err;
    }
  }

  async _fetchFallback(wallet) {
    try {
      const res = await axios.get(
        `https://api.simplehash.com/api/v0/nfts/transfers/accounts`,
        {
          params: { wallet_addresses: wallet, chains: "ethereum", limit: 20, order_by: "timestamp_desc" },
          headers: { "X-API-KEY": process.env.SIMPLEHASH_API_KEY || "" },
          timeout: 10000,
        }
      );
      return (res.data?.transfers || [])
        .filter(t => t.from_address === "0x0000000000000000000000000000000000000000")
        .map(t => ({
          id: t.transaction_hash,
          event_type: "mint",
          transaction: t.transaction_hash,
          nft: {
            name: t.nft?.name || "Unknown NFT",
            identifier: t.nft?.token_id,
            collection: { name: t.collection?.name || "Unknown Collection" },
            permalink: t.nft?.opensea_url,
          },
          quantity: t.quantity || 1,
        }));
    } catch (e) {
      console.error("Fallback fetch error:", e.message);
      return [];
    }
  }

  _formatEvent(event, wallet) {
    const type = event.event_type;
    if (!EVENT_TYPES.includes(type)) return null;

    const nft    = event.nft || event.asset || {};
    const name   = nft.name || nft.identifier || "Unknown NFT";
    const col    = nft.collection?.name || "Unknown Collection";
    const link   = nft.permalink || nft.opensea_url || `https://opensea.io/${wallet}/activity`;
    const qty    = event.quantity > 1 ? ` (x${event.quantity})` : "";
    const time   = new Date().toLocaleString("id-ID", {
      timeZone: "Asia/Jakarta", day: "2-digit", month: "short",
      hour: "2-digit", minute: "2-digit"
    });

    // Label wallet kalau ada
    const label      = this.labels[wallet] || null;
    const walletDisp = label
      ? `${escMd(label)} (\`${wallet.slice(0,6)}...${wallet.slice(-4)}\`)`
      : `\`${wallet.slice(0,8)}...${wallet.slice(-6)}\``;

    if (type === "mint") {
      return (
        `🌟 *MINT TERDETEKSI!*\n\n` +
        `👛 Wallet: ${walletDisp}\n` +
        `🎨 NFT: *${escMd(name)}*${qty}\n` +
        `📦 Koleksi: ${escMd(col)}\n` +
        `🕐 Waktu: ${escMd(time)}\n` +
        `🔗 [Lihat di OpenSea](${link})`
      );
    }

    if (type === "sale") {
      const price = event.payment
        ? `${(Number(event.payment.quantity) / 1e18).toFixed(4)} ${event.payment.symbol || "ETH"}`
        : "N/A";
      return (
        `💰 *SALE TERDETEKSI!*\n\n` +
        `👛 Wallet: ${walletDisp}\n` +
        `🎨 NFT: *${escMd(name)}*${qty}\n` +
        `📦 Koleksi: ${escMd(col)}\n` +
        `💵 Harga: ${escMd(price)}\n` +
        `🕐 Waktu: ${escMd(time)}\n` +
        `🔗 [Lihat di OpenSea](${link})`
      );
    }

    return null;
  }
}

function escMd(text) {
  return String(text || "").replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
}

module.exports = { OpenSeaMonitor };
