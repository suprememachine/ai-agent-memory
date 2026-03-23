// OpenSea Monitor v2 — dengan notif status online/offline & heartbeat
const axios = require("axios");

const WALLET = "0x806eca4d9e4cebea43df3d0fbb4867aa59422c7a";
const OPENSEA_URL = `https://api.opensea.io/api/v2/events/accounts/${WALLET}`;
const POLL_INTERVAL_MS  = 60  * 1000;        // cek event setiap 60 detik
const HEARTBEAT_INTERVAL_MS = 6 * 60 * 60 * 1000; // heartbeat setiap 6 jam
const EVENT_TYPES = ["mint", "sale"];

class OpenSeaMonitor {
  constructor(sendNotification) {
    this.sendNotification   = sendNotification;
    this.seenEventIds       = new Set();
    this.isRunning          = false;
    this.pollTimer          = null;
    this.heartbeatTimer     = null;
    this.apiKey             = process.env.OPENSEA_API_KEY || null;
    this.startTime          = null;
    this.pollCount          = 0;
    this.lastPollOk         = null;
    this.errorCount         = 0;
  }

  async start() {
    if (this.isRunning) return;
    this.isRunning  = true;
    this.startTime  = new Date();

    console.log("👁 OpenSea monitor started for wallet:", WALLET);

    // ── Notif: Monitor AKTIF ──────────────────────────────────────────
    await this._notify(
      `👁 *OpenSea Monitor AKTIF*\n\n` +
      `✅ Bot berhasil start dan mulai memantau\n` +
      `👛 Wallet: \`${WALLET.slice(0,8)}...${WALLET.slice(-6)}\`\n` +
      `🔍 Memantau: Mint & Sale\n` +
      `⏱ Cek setiap: 60 detik\n` +
      `🕐 Mulai: ${this._timeNow()}\n\n` +
      `_Kamu akan dapat notif otomatis saat ada aktivitas\\._`
    );

    // Poll pertama langsung
    await this._poll();

    // Interval polling
    this.pollTimer = setInterval(() => this._poll(), POLL_INTERVAL_MS);

    // Heartbeat setiap 6 jam — bukti bot masih hidup
    this.heartbeatTimer = setInterval(() => this._sendHeartbeat(), HEARTBEAT_INTERVAL_MS);
  }

  async stop(reason = "manual") {
    if (this.pollTimer)      clearInterval(this.pollTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.isRunning = false;

    const uptime = this._uptime();
    console.log("🛑 OpenSea monitor stopped:", reason);

    // ── Notif: Monitor MATI ───────────────────────────────────────────
    await this._notify(
      `🛑 *OpenSea Monitor BERHENTI*\n\n` +
      `❌ Alasan: ${escMd(reason)}\n` +
      `⏱ Uptime: ${uptime}\n` +
      `📊 Total cek: ${this.pollCount}x\n` +
      `🕐 Waktu: ${this._timeNow()}\n\n` +
      `_Bot akan restart otomatis jika Railway masih aktif\\._`
    );
  }

  // ── Heartbeat ───────────────────────────────────────────────────────
  async _sendHeartbeat() {
    const uptime = this._uptime();
    const lastOk = this.lastPollOk
      ? this.lastPollOk.toLocaleTimeString("id-ID", { timeZone: "Asia/Jakarta" })
      : "belum ada";

    await this._notify(
      `💓 *OpenSea Monitor masih aktif*\n\n` +
      `✅ Status: Online & memantau\n` +
      `👛 Wallet: \`${WALLET.slice(0,8)}...${WALLET.slice(-6)}\`\n` +
      `⏱ Uptime: ${uptime}\n` +
      `📊 Total cek: ${this.pollCount}x\n` +
      `🕐 Cek terakhir OK: ${lastOk}\n` +
      `⚠️ Error terakhir: ${this.errorCount}x\n` +
      `🕐 Waktu: ${this._timeNow()}`
    );
  }

  // ── Poll event OpenSea ──────────────────────────────────────────────
  async _poll() {
    this.pollCount++;
    try {
      const events = await this._fetchEvents();
      if (!events || events.length === 0) {
        this.lastPollOk = new Date();
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

      for (const event of newEvents) {
        const msg = this._formatEvent(event);
        if (msg) await this._notify(msg);
      }
    } catch (err) {
      this.errorCount++;
      console.error("OpenSea poll error:", err.message);

      // Kalau error 5x berturut-turut → kirim notif warning
      if (this.errorCount === 5) {
        await this._notify(
          `⚠️ *OpenSea Monitor: Ada Masalah*\n\n` +
          `❌ Gagal fetch data 5x berturut\\-turut\n` +
          `🔴 Error: ${escMd(err.message)}\n` +
          `🕐 Waktu: ${this._timeNow()}\n\n` +
          `_Monitor tetap berjalan dan akan coba lagi\\._`
        );
      }
    }
  }

  // ── Fetch dari OpenSea API ─────────────────────────────────────────
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
        console.warn("⚠️ OpenSea API key invalid — fallback SimpleHash");
        return await this._fetchFallback();
      }
      if (err.response?.status === 429) {
        console.warn("⚠️ OpenSea rate limited");
        return [];
      }
      throw err;
    }
  }

  // ── Fallback: SimpleHash (free) ────────────────────────────────────
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

  // ── Format pesan notif ─────────────────────────────────────────────
  _formatEvent(event) {
    const type = event.event_type;
    if (!EVENT_TYPES.includes(type)) return null;

    const nft  = event.nft || event.asset || {};
    const name = nft.name || nft.identifier || "Unknown NFT";
    const col  = nft.collection?.name || nft.collection || "Unknown Collection";
    const link = nft.permalink || nft.opensea_url ||
      `https://opensea.io/${WALLET}/activity`;
    const qty  = event.quantity > 1 ? ` \\(x${event.quantity}\\)` : "";
    const time = this._timeNow();

    if (type === "mint") {
      return (
        `🌟 *MINT TERDETEKSI\\!*\n\n` +
        `🎨 NFT: *${escMd(name)}*${qty}\n` +
        `📦 Koleksi: ${escMd(col)}\n` +
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
        `💰 *SALE TERDETEKSI\\!*\n\n` +
        `🎨 NFT: *${escMd(name)}*${qty}\n` +
        `📦 Koleksi: ${escMd(col)}\n` +
        `💵 Harga: ${escMd(price)}\n` +
        `👛 Wallet: \`${WALLET.slice(0,8)}...${WALLET.slice(-6)}\`\n` +
        `🕐 Waktu: ${time}\n` +
        `🔗 [Lihat di OpenSea](${link})`
      );
    }
    return null;
  }

  // ── Helpers ────────────────────────────────────────────────────────
  async _notify(msg) {
    try {
      await this.sendNotification(msg);
    } catch (e) {
      console.error("Notify failed:", e.message);
    }
  }

  _timeNow() {
    return new Date().toLocaleString("id-ID", {
      timeZone: "Asia/Jakarta",
      day: "2-digit", month: "short", year: "numeric",
      hour: "2-digit", minute: "2-digit", second: "2-digit"
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
