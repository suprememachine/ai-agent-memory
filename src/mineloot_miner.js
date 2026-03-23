// MineLoot Auto Miner v4 — deploy + auto claim ALL rewards setelah setiap round
const axios  = require("axios");
const ethers = require("ethers");

const GRID_MINING_ADDRESS = "0xA8E2F506aDcbBF18733A9F0f32e3D70b1A34d723";
const BASE_RPC            = process.env.BASE_RPC_URL || "https://mainnet.base.org";
const API_BASE            = "https://api.mineloot.app";
const ALL_BLOCKS          = Array.from({ length: 25 }, (_, i) => i);

const GRID_MINING_ABI = [
  "function deploy(uint8[] calldata blockIds) payable",
  "function claimETH()",
  "function claimLOOT()",
  "function getCurrentRoundInfo() view returns (uint64, uint256, uint256, uint256, uint256, bool)",
  "function getMinerInfo(uint64 roundId, address miner) view returns (uint256, uint256, bool)",
  "function getTotalPendingRewards(address miner) view returns (uint256, uint256, uint256, uint64)",
];

// Minimal ETH pending yang worth untuk di-claim (hindari waste gas)
const MIN_CLAIM_ETH  = 0.000001;
const MIN_CLAIM_LOOT = 0.001;

class MineLootMiner {
  constructor(sendNotification) {
    this.sendNotification = sendNotification;
    this.isRunning        = false;
    this.timer            = null;
    this.provider         = null;
    this.wallet           = null;
    this.contract         = null;
    this.lastRoundMined   = null;
    this.lastRoundChecked = null;
    this.totalRounds      = 0;
    this.totalWins        = 0;
    this.startTime        = null;

    this.amountEthPerRound = process.env.MINING_AMOUNT_ETH || "0.0001";
    this.enabled           = process.env.MINING_ENABLED === "true";
  }

  async init() {
    if (!this.enabled) {
      console.log("⚠️ MINING_ENABLED != true — MineLoot miner disabled");
      return false;
    }
    const pk = process.env.WALLET_PRIVATE_KEY;
    if (!pk) {
      console.log("⚠️ WALLET_PRIVATE_KEY not set — MineLoot miner disabled");
      return false;
    }
    try {
      this.provider = new ethers.JsonRpcProvider(BASE_RPC);
      this.wallet   = new ethers.Wallet(pk, this.provider);
      this.contract = new ethers.Contract(GRID_MINING_ADDRESS, GRID_MINING_ABI, this.wallet);
      const bal     = await this.provider.getBalance(this.wallet.address);
      console.log(`⛏ Wallet: ${this.wallet.address} | ${ethers.formatEther(bal)} ETH`);
      return true;
    } catch (e) {
      console.error("MineLoot init error:", e.message);
      return false;
    }
  }

  async start() {
    const ok = await this.init();
    if (!ok) return;

    this.isRunning = true;
    this.startTime = new Date();

    await this._notify(
      `⛏ *MineLoot Miner AKTIF*\n\n` +
      `👛 Wallet: \`${this.wallet.address.slice(0,8)}...${this.wallet.address.slice(-6)}\`\n` +
      `💰 Per round: ${this.amountEthPerRound} ETH ÷ 25 blok\n` +
      `🎯 Strategi: All 25 blocks\n` +
      `⚡ Auto-claim: langsung setelah setiap round\n` +
      `🕐 Mulai: ${this._timeNow()}`
    );

    // Klaim semua pending rewards saat pertama kali start
    await this._claimAll("start");

    this.timer = setInterval(() => this._loop(), 15 * 1000);
    await this._loop();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.isRunning = false;
    console.log("🛑 MineLoot miner stopped");
  }

  // ── Main loop ──────────────────────────────────────────────────────────
  async _loop() {
    try {
      const round = await this._getRoundInfo();
      if (!round) return;

      const { roundId, timeRemaining, isActive } = round;
      const roundIdStr = roundId.toString();

      // ── Cek hasil + klaim round sebelumnya ─────────────────────────
      if (this.lastRoundMined &&
          this.lastRoundMined !== this.lastRoundChecked &&
          roundIdStr !== this.lastRoundMined) {
        await this._checkRoundResult(BigInt(this.lastRoundMined));
        this.lastRoundChecked = this.lastRoundMined;
      }

      // ── Deploy round baru ──────────────────────────────────────────
      if (!isActive) return;
      if (this.lastRoundMined === roundIdStr) return;
      if (Number(timeRemaining) > 30) return;

      // Cek sudah deploy via on-chain
      const minerInfo = await this.contract.getMinerInfo(roundId, this.wallet.address);
      if (minerInfo[0] > 0n) {
        this.lastRoundMined = roundIdStr;
        return;
      }

      // Cek balance cukup
      const bal       = await this.provider.getBalance(this.wallet.address);
      const amount    = ethers.parseEther(this.amountEthPerRound);
      const gasBuffer = ethers.parseEther("0.001"); // buffer gas lebih besar karena juga claim
      if (bal < amount + gasBuffer) {
        await this._notifyLowBalance(bal);
        return;
      }

      await this._deploy(roundId, amount);

    } catch (e) {
      console.error("Mining loop error:", e.message);
    }
  }

  // ── Deploy ─────────────────────────────────────────────────────────────
  async _deploy(roundId, amount) {
    try {
      console.log(`⛏ Deploying round ${roundId}...`);
      const tx      = await this.contract.deploy(ALL_BLOCKS, { value: amount, gasLimit: 500000n });
      this.lastRoundMined = roundId.toString();
      this.totalRounds++;
      const receipt = await tx.wait(1);
      const gasEth  = ethers.formatEther(receipt.gasUsed * receipt.gasPrice);

      console.log(`✅ Round ${roundId} deployed`);
      await this._notify(
        `⛏ *Deploy Round ${roundId}*\n\n` +
        `✅ Berhasil!\n` +
        `💰 Total: ${ethers.formatEther(amount)} ETH\n` +
        `🎯 25 blok × ${(parseFloat(ethers.formatEther(amount))/25).toFixed(7)} ETH\n` +
        `⛽ Gas: ${parseFloat(gasEth).toFixed(6)} ETH\n` +
        `📊 Round ke-${this.totalRounds} | Wins: ${this.totalWins}`
      );
    } catch (e) {
      if (e.message?.includes("AlreadyDeployed")) {
        this.lastRoundMined = roundId.toString();
        return;
      }
      console.error("Deploy error:", e.message);
    }
  }

  // ── Cek hasil round + langsung klaim ──────────────────────────────────
  async _checkRoundResult(roundId) {
    try {
      // Tunggu sebentar agar kontrak selesai settle
      await new Promise(r => setTimeout(r, 5000));

      // Ambil data round dari API
      const res = await axios.get(`${API_BASE}/api/round/${roundId}`, { timeout: 8000 });
      const r   = res.data;
      if (!r || !r.settled) return;

      const winningBlock = r.winningBlock;
      const totalPool    = r.totalDeployedFormatted || "?";
      const lootpotHit   = r.lootpotAmount && r.lootpotAmount !== "0";
      const lootpotAmt   = r.lootpotPoolFormatted || "0";

      // Ambil pending rewards SEBELUM claim
      const rewards      = await this.contract.getTotalPendingRewards(this.wallet.address);
      const pendingETH   = parseFloat(ethers.formatEther(rewards[0]));
      const unforgedLOOT = parseFloat(ethers.formatEther(rewards[1]));
      const forgedLOOT   = parseFloat(ethers.formatEther(rewards[2]));
      const totalLOOT    = unforgedLOOT + forgedLOOT;
      const lootFee      = unforgedLOOT * 0.10;
      const lootNet      = totalLOOT - lootFee;

      const deployed = parseFloat(this.amountEthPerRound);
      const pnl      = pendingETH - deployed;
      const pnlStr   = pnl >= 0 ? `+${pnl.toFixed(6)}` : pnl.toFixed(6);
      const pnlEmoji = pnl >= 0 ? "📈" : "📉";

      // Karena all 25 blocks, selalu ada reward
      this.totalWins++;

      // Kirim notif hasil round
      let resultMsg =
        `🏆 *WIN! Round ${roundId}*\n\n` +
        `🎲 Winning block: #${winningBlock}\n` +
        `🏊 Total pool: ${totalPool} ETH\n` +
        `💰 Deployed: ${deployed} ETH\n` +
        `💵 Reward ETH: *${pendingETH.toFixed(6)} ETH*\n` +
        `${pnlEmoji} PnL: ${pnlStr} ETH\n`;

      if (totalLOOT > 0) {
        resultMsg += `🪙 Reward LOOT: *${lootNet.toFixed(4)} LOOT* (net)\n`;
      }
      if (lootpotHit) {
        resultMsg += `\n🎰 *LOOTPOT KENA! +${lootpotAmt} LOOT!*\n`;
      }
      resultMsg +=
        `📊 Total: ${this.totalRounds} rounds | ${this.totalWins} wins\n` +
        `🔗 [BaseScan](https://basescan.org/address/${this.wallet.address})`;

      await this._notify(resultMsg);

      // ── Langsung klaim semua rewards ─────────────────────────────
      await this._claimAll("round");

    } catch (e) {
      if (e.response?.status === 404) return; // round belum tersedia di API
      console.error("checkRoundResult error:", e.message);
    }
  }

  // ── Klaim semua ETH + LOOT langsung tanpa threshold ───────────────────
  async _claimAll(trigger = "manual") {
    try {
      const rewards      = await this.contract.getTotalPendingRewards(this.wallet.address);
      const pendingETH   = parseFloat(ethers.formatEther(rewards[0]));
      const unforgedLOOT = parseFloat(ethers.formatEther(rewards[1]));
      const forgedLOOT   = parseFloat(ethers.formatEther(rewards[2]));
      const totalLOOT    = unforgedLOOT + forgedLOOT;
      const lootFee      = unforgedLOOT * 0.10;
      const lootNet      = totalLOOT - lootFee;

      let claimedETH  = false;
      let claimedLOOT = false;
      let ethTx = null, lootTx = null;

      // Klaim ETH kalau ada
      if (pendingETH >= MIN_CLAIM_ETH) {
        try {
          console.log(`💰 Claiming ${pendingETH} ETH...`);
          ethTx = await this.contract.claimETH({ gasLimit: 200000n });
          await ethTx.wait(1);
          claimedETH = true;
          console.log(`✅ ETH claimed: ${pendingETH}`);
        } catch (e) {
          console.error("claimETH error:", e.message);
        }
      }

      // Klaim LOOT kalau ada
      if (totalLOOT >= MIN_CLAIM_LOOT) {
        try {
          console.log(`🪙 Claiming ${totalLOOT} LOOT...`);
          lootTx = await this.contract.claimLOOT({ gasLimit: 200000n });
          await lootTx.wait(1);
          claimedLOOT = true;
          console.log(`✅ LOOT claimed: ${lootNet}`);
        } catch (e) {
          console.error("claimLOOT error:", e.message);
        }
      }

      // Notif klaim — hanya kalau trigger bukan "round" (sudah ada di result notif)
      // Kalau trigger "round", gabungkan info klaim di satu notif
      if ((claimedETH || claimedLOOT) && trigger !== "round") {
        let msg = `💰 *Rewards Diklaim!*\n\n`;
        if (claimedETH) {
          msg += `✅ ETH: *${pendingETH.toFixed(6)} ETH*\n`;
          msg += `🔗 [ETH Tx](https://basescan.org/tx/${ethTx.hash})\n`;
        }
        if (claimedLOOT) {
          msg += `✅ LOOT: *${lootNet.toFixed(4)} LOOT* (net)\n`;
          msg += `   Unforged: ${unforgedLOOT.toFixed(4)} | Forged: ${forgedLOOT.toFixed(4)}\n`;
          msg += `   Fee: -${lootFee.toFixed(4)} LOOT\n`;
          msg += `🔗 [LOOT Tx](https://basescan.org/tx/${lootTx.hash})\n`;
        }
        msg += `🕐 ${this._timeNow()}`;
        await this._notify(msg);
      }

      // Kalau trigger "round" — kirim notif klaim terpisah yang ringkas
      if ((claimedETH || claimedLOOT) && trigger === "round") {
        let msg = `⚡ *Auto-Claim Selesai*\n\n`;
        if (claimedETH)  msg += `✅ ETH: ${pendingETH.toFixed(6)} ETH → [Tx](https://basescan.org/tx/${ethTx.hash})\n`;
        if (claimedLOOT) msg += `✅ LOOT: ${lootNet.toFixed(4)} LOOT → [Tx](https://basescan.org/tx/${lootTx.hash})\n`;
        await this._notify(msg);
      }

    } catch (e) {
      console.error("claimAll error:", e.message);
    }
  }

  async _notifyLowBalance(bal) {
    const now = Date.now();
    if (this._lastLowBalNotif && now - this._lastLowBalNotif < 3600000) return;
    this._lastLowBalNotif = now;
    const balEth = parseFloat(ethers.formatEther(bal));
    await this._notify(
      `⚠️ *Balance Tidak Cukup!*\n\n` +
      `💰 Balance: ${balEth.toFixed(6)} ETH\n` +
      `💸 Butuh: ${this.amountEthPerRound} ETH + gas\n` +
      `👛 Top up: \`${this.wallet.address}\`\n` +
      `🕐 ${this._timeNow()}`
    );
  }

  async _getRoundInfo() {
    try {
      const info = await this.contract.getCurrentRoundInfo();
      return { roundId: info[0], timeRemaining: info[4], isActive: info[5] };
    } catch {
      try {
        const res = await axios.get(`${API_BASE}/api/round/current`, { timeout: 5000 });
        const d   = res.data;
        const now = Math.floor(Date.now() / 1000);
        return {
          roundId:       BigInt(d.roundId),
          timeRemaining: BigInt(Math.max(0, d.endTime - now)),
          isActive:      !d.settled,
        };
      } catch { return null; }
    }
  }

  async _notify(msg) {
    try { await this.sendNotification(msg); }
    catch (e) { console.error("Notify failed:", e.message); }
  }

  _timeNow() {
    return new Date().toLocaleString("id-ID", {
      timeZone: "Asia/Jakarta",
      day: "2-digit", month: "short",
      hour: "2-digit", minute: "2-digit"
    });
  }

  get walletAddress() { return this.wallet?.address || null; }
}

module.exports = { MineLootMiner };
