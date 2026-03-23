// OpenSea Monitor — polling wallet activity via OpenSea API v2
// Mendeteksi event mint/sale baru dan kirim notif Telegram
const axios = require("axios");

const WALLET = "0x806eca4d9e4cebea43df3d0fbb4867aa59422c7a";
const OPENSEA_URL = `https://api.opensea.io/api/v2/events/accounts/${WALLET}`;
const POLL_INTERVAL_MS = 60 * 1000; // cek setiap 60 detik
const EVENT_TYPES = ["mint", "sale"];

class OpenSeaMonitor {
  constructor(sendNotification) {
    this.sendNotification = sendNotification; // callback kirim pesan Telegram
    this.lastEventTimestamp = null;
    this.seenEventIds = new Set();
    this.isRunning = false;
    this.timer = null;
    this.apiKey = process.env.OPENSEA_API_KEY || null;
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.lastEventTimestamp = new Date().toISOString();
    console.log("👁 OpenSea monitor started for wallet:", WALLET);
    this._poll(); // poll pertama langsung
    this.timer = setInterval(() => this._poll(), POLL_INTERVAL_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.isRunning = false;
    console.log("🛑 OpenSea monitor stopped");
  }

  async _poll() {
    try {
      const events = await this._fetchEvents();
      if (!events || events.length === 0) return;

      // Filter event baru yang belum dilihat
      const newEvents = events.filter(e => {
        const id = e.id || `${e.event_type}-${e.transaction}`;
        if (this.seenEventIds.has(id)) return false;
        this.seenEventIds.add(id);
        // Batasi ukuran Set agar tidak memory leak
        if (this.seenEventIds.size > 500) {
          const first = this.seenEventIds.values().next().value;
          this.seenEventIds.delete(first);
        }
        return true;
      });

      for (const event of newEvents) {
        const msg = this._formatEvent(event);
        if (msg) {
          await this.sendNotification(msg);
        }
      }
    } catch (err) {
      console.error("OpenSea monitor poll error:", err.message);
    }
  }

  async _fetchEvents() {
    const headers = {
      "accept": "application/json",
      "x-api-key": this.apiKey || "",
    };

    // Coba OpenSea API v2
    try {
      const res = await axios.get(OPENSEA_URL, {
        params: {
          event_type: EVENT_TYPES,
          limit: 20,
        },
        headers,
        timeout: 10000,
      });
      return res.data?.asset_events || [];
    } catch (err) {
      // Fallback: coba tanpa API key atau handle 401/429
      if (err.response?.status === 401 || err.response?.status === 403) {
        console.warn("⚠️ OpenSea API key invalid/missing. Set OPENSEA_API_KEY env var.");
        // Fallback ke reservoir/SimpleHash
        return await this._fetchFallback();
      }
      if (err.response?.status === 429) {
        console.warn("⚠️ OpenSea rate limited. Tunggu sebentar...");
        return [];
      }
      throw err;
    }
  }

  // Fallback: SimpleHash API (free, no key needed)
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
      // Filter hanya mints (from address = zero address)
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

    const nft = event.nft || event.asset || {};
    const name = nft.name || nft.identifier || "Unknown NFT";
    const collection = nft.collection?.name || nft.collection || "Unknown Collection";
    const link = nft.permalink || nft.opensea_url ||
      `https://opensea.io/${WALLET}/activity`;
    const image = nft.image_url || nft.image_preview_url || "";
    const qty = event.quantity > 1 ? ` (x${event.quantity})` : "";
    const time = new Date().toLocaleTimeString("id-ID", { timeZone: "Asia/Jakarta" });

    if (type === "mint") {
      return (
        `🌟 *MINT TERDETEKSI!*\n\n` +
        `🎨 NFT: *${escMd(name)}*${qty}\n` +
        `📦 Koleksi: ${escMd(collection)}\n` +
        `👛 Wallet: \`${WALLET.slice(0,8)}...${WALLET.slice(-6)}\`\n` +
        `🕐 Waktu: ${time}\n` +
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
        `📦 Koleksi: ${escMd(collection)}\n` +
        `💵 Harga: ${price}\n` +
        `👛 Wallet: \`${WALLET.slice(0,8)}...${WALLET.slice(-6)}\`\n` +
        `🕐 Waktu: ${time}\n` +
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
