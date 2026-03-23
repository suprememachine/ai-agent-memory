// MineLoot Auto Miner v2 — deploy + claim ETH + claim LOOT otomatis
const axios  = require("axios");
const ethers = require("ethers");

const GRID_MINING_ADDRESS = "0xA8E2F506aDcbBF18733A9F0f32e3D70b1A34d723";
const BASE_RPC            = process.env.BASE_RPC_URL || "https://mainnet.base.org";
const API_BASE            = "https://api.mineloot.app";
const ALL_BLOCKS          = Array.from({ length: 25 }, (_, i) => i); // [0..24]

const GRID_MINING_ABI = [
  "function deploy(uint8[] calldata blockIds) payable",
  "function claimETH() nonpayable",
  "function claimLOOT() nonpayable",
  "function getCurrentRoundInfo() view returns (uint64, uint256, uint256, uint256, uint256, bool)",
  "function getMinerInfo(uint64 roundId, address miner) view returns (uint256, uint256, bool)",
  "function getTotalPendingRewards(address miner) view returns (uint256 pendingETH, uint256 unforgedLOOT, uint256 forgedLOOT, uint64 uncheckpointedRound)",
  "function getPendingLOOT(address miner) view returns (uint256 gross, uint256 fee, uint256 net)",
];

class MineLootMiner {
  constructor(sendNotification) {
    this.sendNotification  = sendNotification;
    this.isRunning         = false;
    this.timer             = null;
    this.provider          = null;
    this.wallet            = null;
    this.contract          = null;
    this.lastRoundMined    = null;
    this.totalRounds       = 0;
    this.startTime         = null;

    // Config dari env
    this.amountEthPerRound  = process.env.MINING_AMOUNT_ETH     || "0.0001";
    this.claimThresholdEth  = parseFloat(process.env.CLAIM_THRESHOLD_ETH  || "0.001");
    this.claimThresholdLoot = parseFloat(process.env.CLAIM_THRESHOLD_LOOT || "1.0");
    this.enabled            = process.env.MINING_ENABLED === "true";

    // Cek setiap N rounds sekali untuk claim
    this.claimEveryNRounds  = parseInt(process.env.CLAIM_EVERY_N_ROUNDS || "10");
  }

  async init() {
    const privateKey = process.env.WALLET_PRIVATE_KEY;
    if (!privateKey) {
      console.log("⚠️ WALLET_PRIVATE_KEY not set — MineLoot miner disabled");
      return false;
    }
    if (!this.enabled) {
      console.log("⚠️ MINING_ENABLED != true — MineLoot miner disabled");
      return false;
    }
    try {
      this.provider = new ethers.JsonRpcProvider(BASE_RPC);
      this.wallet   = new ethers.Wallet(privateKey, this.provider);
      this.contract = new ethers.Contract(GRID_MINING_ADDRESS, GRID_MINING_ABI, this.wallet);

      const bal = await this.provider.getBalance(this.wallet.address);
      console.log(`⛏ MineLoot wallet: ${this.wallet.address}`);
      console.log(`⛏ Balance: ${ethers.formatEther(bal)} ETH`);
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
    console.log(`⛏ MineLoot miner started — ${this.amountEthPerRound} ETH/round`);

    await this._notify(
      `⛏ *MineLoot Miner AKTIF*\n\n` +
      `👛 Wallet: \`${this.wallet.address.slice(0,8)}...${this.wallet.address.slice(-6)}\`\n` +
      `💰 Per round: ${this.amountEthPerRound} ETH\n` +
      `🎯 Strategi: All 25 blocks\n` +
      `💵 Auto-claim ETH > ${this.claimThresholdEth} ETH\n` +
      `🪙 Auto-claim LOOT > ${this.claimThresholdLoot} LOOT\n` +
      `🕐 Mulai: ${this._timeNow()}`
    );

    // Cek pending rewards saat pertama kali start
    await this._checkAndClaim(true);

    this.timer = setInterval(() => this._loop(), 15 * 1000);
    await this._loop();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.isRunning = false;
    console.log("🛑 MineLoot miner stopped");
  }

  async _loop() {
    try {
      const round = await this._getRoundInfo();
      if (!round || !round.isActive) return;

      const { roundId, timeRemaining } = round;

      // Skip kalau sudah mine round ini
      if (this.lastRoundMined === roundId.toString()) return;

      // Deploy di 30 detik terakhir
      if (Number(timeRemaining) > 30) return;

      // Cek sudah deploy via on-chain
      const minerInfo = await this.contract.getMinerInfo(roundId, this.wallet.address);
      if (minerInfo[0] > 0n) {
        this.lastRoundMined = roundId.toString();
        return;
      }

      // Cek balance cukup
      const bal        = await this.provider.getBalance(this.wallet.address);
      const amount     = ethers.parseEther(this.amountEthPerRound);
      const gasBuffer  = ethers.parseEther("0.0005");
      if (bal < amount + gasBuffer) {
        await this._notifyLowBalance(bal);
        return;
      }

      // Deploy
      await this._deploy(roundId, amount);

      // Cek claim setiap N rounds
      if (this.totalRounds % this.claimEveryNRounds === 0) {
        await this._checkAndClaim(false);
      }

    } catch (e) {
      console.error("Mining loop error:", e.message);
    }
  }

  async _deploy(roundId, amount) {
    try {
      console.log(`⛏ Deploying round ${roundId} — ${ethers.formatEther(amount)} ETH`);
      const tx      = await this.contract.deploy(ALL_BLOCKS, { value: amount, gasLimit: 500000n });
      this.lastRoundMined = roundId.toString();
      this.totalRounds++;
      const receipt = await tx.wait(1);
      const gasEth  = ethers.formatEther(receipt.gasUsed * receipt.gasPrice);

      console.log(`✅ Round ${roundId} deployed. Gas: ${gasEth} ETH`);
      await this._notify(
        `⛏ *Mining Round ${roundId}*\n\n` +
        `✅ Deploy berhasil!\n` +
        `💰 Amount: ${ethers.formatEther(amount)} ETH\n` +
        `🎯 Blocks: semua 25 blok\n` +
        `⛽ Gas: ${parseFloat(gasEth).toFixed(6)} ETH\n` +
        `📊 Total rounds: ${this.totalRounds}\n` +
        `🔗 [Lihat Tx](https://basescan.org/tx/${tx.hash})`
      );
    } catch (e) {
      if (e.message?.includes("AlreadyDeployed")) {
        this.lastRoundMined = roundId.toString();
        return;
      }
      console.error("Deploy error:", e.message);
    }
  }

  // ── Claim ETH + LOOT ────────────────────────────────────────────────────
  async _checkAndClaim(force = false) {
    try {
      const rewards = await this.contract.getTotalPendingRewards(this.wallet.address);
      const pendingETH  = parseFloat(ethers.formatEther(rewards[0]));
      const unforgedLOOT = parseFloat(ethers.formatEther(rewards[1]));
      const forgedLOOT   = parseFloat(ethers.formatEther(rewards[2]));
      const totalLOOT    = unforgedLOOT + forgedLOOT;

      console.log(`📊 Pending — ETH: ${pendingETH}, LOOT: ${totalLOOT}`);

      let claimedETH  = false;
      let claimedLOOT = false;
      let ethTx       = null;
      let lootTx      = null;

      // ── Claim ETH ────────────────────────────────────────────────────
      if (pendingETH >= this.claimThresholdEth || (force && pendingETH > 0)) {
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

      // ── Claim LOOT ────────────────────────────────────────────────────
      // Hitung net LOOT setelah fee 10% pada bagian unforged
      const lootFee  = unforgedLOOT * 0.10;
      const lootNet  = totalLOOT - lootFee;

      if (totalLOOT >= this.claimThresholdLoot || (force && totalLOOT > 0)) {
        try {
          console.log(`🪙 Claiming ${totalLOOT} LOOT (net: ${lootNet})...`);
          lootTx = await this.contract.claimLOOT({ gasLimit: 200000n });
          await lootTx.wait(1);
          claimedLOOT = true;
          console.log(`✅ LOOT claimed. Net: ${lootNet}`);
        } catch (e) {
          console.error("claimLOOT error:", e.message);
        }
      }

      // ── Kirim notif kalau ada yang berhasil diklaim ───────────────────
      if (claimedETH || claimedLOOT) {
        let msg = `💰 *MineLoot: Rewards Diklaim!*\n\n`;

        if (claimedETH) {
          msg += `✅ ETH: *${pendingETH.toFixed(6)} ETH*\n`;
          msg += `🔗 [ETH Tx](https://basescan.org/tx/${ethTx.hash})\n`;
        }
        if (claimedLOOT) {
          msg += `✅ LOOT: *${lootNet.toFixed(4)} LOOT* (net)\n`;
          msg += `   • Unforged: ${unforgedLOOT.toFixed(4)} LOOT\n`;
          msg += `   • Forged bonus: ${forgedLOOT.toFixed(4)} LOOT\n`;
          msg += `   • Fee 10%: -${lootFee.toFixed(4)} LOOT\n`;
          msg += `🔗 [LOOT Tx](https://basescan.org/tx/${lootTx.hash})\n`;
        }

        msg += `🕐 Waktu: ${this._timeNow()}`;
        await this._notify(msg);
      } else if (force && pendingETH === 0 && totalLOOT === 0) {
        // Saat start, kalau memang belum ada rewards — tidak perlu notif
        console.log("📊 No pending rewards at startup");
      }

    } catch (e) {
      console.error("checkAndClaim error:", e.message);
    }
  }

  async _notifyLowBalance(bal) {
    const balEth = parseFloat(ethers.formatEther(bal));
    // Notif hanya sekali per jam supaya tidak spam
    const now = Date.now();
    if (this._lastLowBalNotif && now - this._lastLowBalNotif < 60 * 60 * 1000) return;
    this._lastLowBalNotif = now;

    console.warn(`⚠️ Low balance: ${balEth} ETH`);
    await this._notify(
      `⚠️ *MineLoot: Balance Tidak Cukup*\n\n` +
      `💰 Balance: ${balEth.toFixed(6)} ETH\n` +
      `💸 Dibutuhkan: ${this.amountEthPerRound} ETH + gas\n` +
      `👛 Top up ke: \`${this.wallet.address}\`\n` +
      `🕐 ${this._timeNow()}`
    );
  }

  async _getRoundInfo() {
    try {
      const info = await this.contract.getCurrentRoundInfo();
      return {
        roundId:       info[0],
        timeRemaining: info[4],
        isActive:      info[5],
      };
    } catch (e) {
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
