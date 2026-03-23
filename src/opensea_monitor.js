// OpenSea Monitor v3 — silent mode, notif HANYA kalau ada mint/sale
const axios = require("axios");

const WALLET = "0x806eca4d9e4cebea43df3d0fbb4867aa59422c7a";
const OPENSEA_URL = `https://api.opensea.io/api/v2/events/accounts/${WALLET}`;
const POLL_INTERVAL_MS = 60 * 1000; // cek setiap 60 detik
const EVENT_TYPES = ["mint", "sale"];

class OpenSeaMonitor {
  constructor(sendNotification) {
    this.sendNotification = sendNotification;
    this.seenEventIds     = new Set();
    this.isRunning        = false;
    this.pollTimer        = null;
    this.apiKey           = process.env.OPENSEA_API_KEY || null;
    this.pollCount        = 0;
    this.errorCount       = 0;
    this.lastPollOk       = null;
    this.startTime        = null;
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.startTime = new Date();
    // Hanya log ke console, TIDAK kirim Telegram
    console.log("👁 OpenSea monitor started for wallet:", WALLET);
    this._poll();
    this.pollTimer = setInterval(() => this._poll(), POLL_INTERVAL_MS);
  }

  stop() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.isRunning = false;
    // Hanya log ke console, TIDAK kirim Telegram
    console.log("🛑 OpenSea monitor stopped. Polls:", this.pollCount);
  }

  async _poll() {
    this.pollCount++;
    try {
      const events = await this._fetchEvents();
      if (!events || events.length === 0) {
        this.lastPollOk = new Date();
        this.errorCount = 0;
        return;
      }

      const newEvents = events.filter(e => {
        const id = e.id || `${e.event_type}-${e.transaction}`;
        if (this.seenEventIds.has(id)) return false;
        this.seenEventIds.add(id);
        if (this.seenEventIds.size > 500) {
          const first = this.seenEventIds.values().next().value;
          this.seenEventIds.delete(first);
        }
        return true;
      });

      this.lastPollOk = new Date();
      this.errorCount = 0;

      // Hanya kirim notif kalau ada event baru
      for (const event of newEvents) {
        const msg = this._formatEvent(event);
        if (msg) {
          try {
            await this.sendNotification(msg);
          } catch (e) {
            console.error("Notify failed:", e.message);
          }
        }
      }
    } catch (err) {
      this.errorCount++;
      // Log error ke console saja, tidak spam Telegram
      console.error(`OpenSea poll error #${this.errorCount}:`, err.message);
    }
  }

  async _fetchEvents() {
    const headers = {
      "accept": "application/json",
      ...(this.apiKey ? { "x-api-key": this.apiKey } : {}),
    };
    try {
      const res = await axios.get(OPENSEA_URL, {
        params: { event_type: EVENT_TYPES, limit: 20 },
        headers,
        timeout: 10000,
      });
      return res.data?.asset_events || [];
    } catch (err) {
      if (err.response?.status === 401 || err.response?.status === 403) {
        return await this._fetchFallback();
      }
      if (err.response?.status === 429) {
        console.warn("⚠️ OpenSea rate limited");
        return [];
      }
      throw err;
    }
  }

  async _fetchFallback() {
    try {
      const res = await axios.get(
        `https://api.simplehash.com/api/v0/nfts/transfers/accounts`,
        {
          params: {
            wallet_addresses: WALLET,
            chains: "ethereum",
            limit: 20,
            order_by: "timestamp_desc",
          },
          headers: { "X-API-KEY": process.env.SIMPLEHASH_API_KEY || "" },
          timeout: 10000,
        }
      );
      const transfers = res.data?.transfers || [];
      return transfers
        .filter(t => t.from_address === "0x0000000000000000000000000000000000000000")
        .map(t => ({
          id: t.transaction_hash,
          event_type: "mint",
          transaction: t.transaction_hash,
          nft: {
            name: t.nft?.name || "Unknown NFT",
            identifier: t.nft?.token_id,
            collection: { name: t.collection?.name || "Unknown Collection" },
            image_url: t.nft?.image_url,
            permalink: t.nft?.opensea_url,
          },
          created_date: t.timestamp,
          quantity: t.quantity || 1,
        }));
    } catch (e) {
      console.error("Fallback fetch error:", e.message);
      return [];
    }
  }

  _formatEvent(event) {
    const type = event.event_type;
    if (!EVENT_TYPES.includes(type)) return null;

    const nft  = event.nft || event.asset || {};
    const name = nft.name || nft.identifier || "Unknown NFT";
    const col  = nft.collection?.name || nft.collection || "Unknown Collection";
    const link = nft.permalink || nft.opensea_url ||
      `https://opensea.io/${WALLET}/activity`;
    const qty  = event.quantity > 1 ? ` (x${event.quantity})` : "";
    const time = new Date().toLocaleString("id-ID", {
      timeZone: "Asia/Jakarta",
      day: "2-digit", month: "short",
      hour: "2-digit", minute: "2-digit"
    });

    if (type === "mint") {
      return (
        `🌟 *MINT TERDETEKSI!*\n\n` +
        `🎨 NFT: *${escMd(name)}*${qty}\n` +
        `📦 Koleksi: ${escMd(col)}\n` +
        `👛 Wallet: \`${WALLET.slice(0,8)}...${WALLET.slice(-6)}\`\n` +
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
        `🎨 NFT: *${escMd(name)}*${qty}\n` +
        `📦 Koleksi: ${escMd(col)}\n` +
        `💵 Harga: ${escMd(price)}\n` +
        `👛 Wallet: \`${WALLET.slice(0,8)}...${WALLET.slice(-6)}\`\n` +
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
