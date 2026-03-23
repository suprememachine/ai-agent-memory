// MineLoot Auto Miner v3 — deploy + win/lose notif + claim ETH + claim LOOT
const axios  = require("axios");
const ethers = require("ethers");

const GRID_MINING_ADDRESS = "0xA8E2F506aDcbBF18733A9F0f32e3D70b1A34d723";
const BASE_RPC            = process.env.BASE_RPC_URL || "https://mainnet.base.org";
const API_BASE            = "https://api.mineloot.app";
const ALL_BLOCKS          = Array.from({ length: 25 }, (_, i) => i);

const GRID_MINING_ABI = [
  "function deploy(uint8[] calldata blockIds) payable",
  "function claimETH() nonpayable",
  "function claimLOOT() nonpayable",
  "function getCurrentRoundInfo() view returns (uint64, uint256, uint256, uint256, uint256, bool)",
  "function getMinerInfo(uint64 roundId, address miner) view returns (uint256, uint256, bool)",
  "function getTotalPendingRewards(address miner) view returns (uint256, uint256, uint256, uint64)",
];

class MineLootMiner {
  constructor(sendNotification) {
    this.sendNotification   = sendNotification;
    this.isRunning          = false;
    this.timer              = null;
    this.provider           = null;
    this.wallet             = null;
    this.contract           = null;
    this.lastRoundMined     = null;  // round terakhir yang di-deploy
    this.lastRoundChecked   = null;  // round terakhir yang dicek hasilnya
    this.totalRounds        = 0;
    this.totalWins          = 0;
    this.totalLoses         = 0;
    this.startTime          = null;

    this.amountEthPerRound  = process.env.MINING_AMOUNT_ETH      || "0.0001";
    this.claimThresholdEth  = parseFloat(process.env.CLAIM_THRESHOLD_ETH  || "0.001");
    this.claimThresholdLoot = parseFloat(process.env.CLAIM_THRESHOLD_LOOT || "1.0");
    this.claimEveryNRounds  = parseInt(process.env.CLAIM_EVERY_N_ROUNDS   || "10");
    this.enabled            = process.env.MINING_ENABLED === "true";
  }

  // ── Init ──────────────────────────────────────────────────────────────
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
      console.log(`⛏ Wallet: ${this.wallet.address} | Balance: ${ethers.formatEther(bal)} ETH`);
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
      `💰 Per round: ${this.amountEthPerRound} ETH (÷25 blok)\n` +
      `🎯 Strategi: All 25 blocks\n` +
      `💵 Auto-claim ETH ≥ ${this.claimThresholdEth} ETH\n` +
      `🪙 Auto-claim LOOT ≥ ${this.claimThresholdLoot} LOOT\n` +
      `🕐 Mulai: ${this._timeNow()}`
    );

    await this._checkAndClaim(true); // cek pending rewards saat start
    this.timer = setInterval(() => this._loop(), 15 * 1000);
    await this._loop();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.isRunning = false;
    console.log("🛑 MineLoot miner stopped");
  }

  // ── Main loop ─────────────────────────────────────────────────────────
  async _loop() {
    try {
      const round = await this._getRoundInfo();
      if (!round) return;

      const { roundId, timeRemaining, isActive } = round;
      const roundIdStr = roundId.toString();

      // ── Cek hasil round sebelumnya ──────────────────────────────────
      if (this.lastRoundMined &&
          this.lastRoundMined !== this.lastRoundChecked &&
          roundIdStr !== this.lastRoundMined) {
        await this._checkRoundResult(BigInt(this.lastRoundMined));
        this.lastRoundChecked = this.lastRoundMined;
      }

      // ── Deploy round baru ───────────────────────────────────────────
      if (!isActive) return;
      if (this.lastRoundMined === roundIdStr) return;
      if (Number(timeRemaining) > 30) return;

      // Cek sudah deploy via on-chain
      const minerInfo = await this.contract.getMinerInfo(roundId, this.wallet.address);
      if (minerInfo[0] > 0n) {
        this.lastRoundMined = roundIdStr;
        return;
      }

      // Cek balance
      const bal       = await this.provider.getBalance(this.wallet.address);
      const amount    = ethers.parseEther(this.amountEthPerRound);
      const gasBuffer = ethers.parseEther("0.0005");
      if (bal < amount + gasBuffer) {
        await this._notifyLowBalance(bal);
        return;
      }

      await this._deploy(roundId, amount);

      // Auto-claim setiap N rounds
      if (this.totalRounds % this.claimEveryNRounds === 0) {
        await this._checkAndClaim(false);
      }

    } catch (e) {
      console.error("Mining loop error:", e.message);
    }
  }

  // ── Deploy ────────────────────────────────────────────────────────────
  async _deploy(roundId, amount) {
    try {
      console.log(`⛏ Deploying round ${roundId} — ${ethers.formatEther(amount)} ETH`);
      const tx      = await this.contract.deploy(ALL_BLOCKS, { value: amount, gasLimit: 500000n });
      this.lastRoundMined = roundId.toString();
      this.totalRounds++;
      const receipt = await tx.wait(1);
      const gasEth  = ethers.formatEther(receipt.gasUsed * receipt.gasPrice);

      console.log(`✅ Round ${roundId} deployed`);
      await this._notify(
        `⛏ *Mining Round ${roundId}*\n\n` +
        `✅ Deploy berhasil!\n` +
        `💰 Total: ${ethers.formatEther(amount)} ETH\n` +
        `🎯 25 blok × ${(parseFloat(ethers.formatEther(amount))/25).toFixed(7)} ETH\n` +
        `⛽ Gas: ${parseFloat(gasEth).toFixed(6)} ETH\n` +
        `📊 Rounds: ${this.totalRounds} | W:${this.totalWins} L:${this.totalLoses}\n` +
        `🔗 [Tx](https://basescan.org/tx/${tx.hash})`
      );
    } catch (e) {
      if (e.message?.includes("AlreadyDeployed")) {
        this.lastRoundMined = roundId.toString();
        return;
      }
      console.error("Deploy error:", e.message);
    }
  }

  // ── Cek hasil round — WIN atau LOSE ───────────────────────────────────
  async _checkRoundResult(roundId) {
    try {
      // Ambil data round dari API
      const res = await axios.get(`${API_BASE}/api/round/${roundId}`, { timeout: 8000 });
      const r   = res.data;

      if (!r || !r.settled) return; // belum settle

      const winningBlock = r.winningBlock;

      // Cek apakah kita deploy di round itu
      const minerInfo = await this.contract.getMinerInfo(roundId, this.wallet.address);
      if (minerInfo[0] === 0n) return; // kita tidak deploy di round ini

      // Karena deploy all 25 blocks, kita SELALU ada di winning block
      // Tapi cek reward yang didapat dari API
      let myReward = "0";
      try {
        const minersRes = await axios.get(`${API_BASE}/api/round/${roundId}/miners`, { timeout: 8000 });
        const miners    = minersRes.data?.miners || minersRes.data || [];
        const myData    = miners.find(m =>
          m.address?.toLowerCase() === this.wallet.address.toLowerCase()
        );
        if (myData) {
          myReward = myData.ethRewardFormatted || myData.reward || "0";
        }
      } catch (e) {
        // API miners tidak tersedia, skip detail reward
      }

      const deployed     = ethers.formatEther(minerInfo[1] * 25n); // amountPerBlock × 25
      const lootpotHit   = r.lootpotAmount && r.lootpotAmount !== "0";
      const lootpotAmt   = r.lootpotPoolFormatted || "0";
      const totalPool    = r.totalDeployedFormatted || "?";
      const isSplit      = r.isSplit;

      // Karena all 25 blocks — kita selalu "menang" secara teknis
      // tapi reward bisa kecil kalau banyak pemain lain
      const won = parseFloat(myReward) > 0;
      this.totalWins++;

      let msg = won
        ? `🏆 *WIN! Round ${roundId}*\n\n`
        : `🎯 *Round ${roundId} Selesai*\n\n`;

      msg += `🎲 Winning block: #${winningBlock}\n`;
      msg += `💰 Deployed: ${deployed} ETH\n`;
      msg += `🏊 Total pool: ${totalPool} ETH\n`;

      if (parseFloat(myReward) > 0) {
        msg += `💵 Reward kamu: *${myReward} ETH*\n`;
        const pnl = parseFloat(myReward) - parseFloat(deployed);
        const pnlStr = pnl >= 0 ? `+${pnl.toFixed(6)}` : pnl.toFixed(6);
        msg += `📈 PnL: ${pnlStr} ETH\n`;
      } else {
        msg += `💵 Reward: sedang diproses...\n`;
      }

      if (lootpotHit) {
        msg += `\n🎰 *LOOTPOT KENA! +${lootpotAmt} LOOT*\n`;
      }

      msg += `${isSplit ? "🔀 Mode: Split LOOT" : "🎯 Mode: Single LOOT winner"}\n`;
      msg += `📊 Total: W:${this.totalWins} L:${this.totalLoses}\n`;
      msg += `🔗 [BaseScan](https://basescan.org/address/${this.wallet.address})`;

      await this._notify(msg);

    } catch (e) {
      // Round API belum tersedia — skip saja, tidak spam error
      if (e.response?.status === 404) return;
      console.error("checkRoundResult error:", e.message);
    }
  }

  // ── Claim ETH + LOOT ──────────────────────────────────────────────────
  async _checkAndClaim(force = false) {
    try {
      const rewards      = await this.contract.getTotalPendingRewards(this.wallet.address);
      const pendingETH   = parseFloat(ethers.formatEther(rewards[0]));
      const unforgedLOOT = parseFloat(ethers.formatEther(rewards[1]));
      const forgedLOOT   = parseFloat(ethers.formatEther(rewards[2]));
      const totalLOOT    = unforgedLOOT + forgedLOOT;

      let claimedETH  = false;
      let claimedLOOT = false;
      let ethTx = null, lootTx = null;

      // Claim ETH
      if (pendingETH >= this.claimThresholdEth || (force && pendingETH > 0.000001)) {
        try {
          ethTx = await this.contract.claimETH({ gasLimit: 200000n });
          await ethTx.wait(1);
          claimedETH = true;
          console.log(`✅ Claimed ${pendingETH} ETH`);
        } catch (e) { console.error("claimETH error:", e.message); }
      }

      // Claim LOOT
      const lootFee = unforgedLOOT * 0.10;
      const lootNet = totalLOOT - lootFee;
      if (totalLOOT >= this.claimThresholdLoot || (force && totalLOOT > 0.01)) {
        try {
          lootTx = await this.contract.claimLOOT({ gasLimit: 200000n });
          await lootTx.wait(1);
          claimedLOOT = true;
          console.log(`✅ Claimed ${lootNet} LOOT`);
        } catch (e) { console.error("claimLOOT error:", e.message); }
      }

      if (claimedETH || claimedLOOT) {
        let msg = `💰 *MineLoot: Rewards Diklaim!*\n\n`;
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
    } catch (e) {
      console.error("checkAndClaim error:", e.message);
    }
  }

  async _notifyLowBalance(bal) {
    const now = Date.now();
    if (this._lastLowBalNotif && now - this._lastLowBalNotif < 3600000) return;
    this._lastLowBalNotif = now;
    const balEth = parseFloat(ethers.formatEther(bal));
    await this._notify(
      `⚠️ *MineLoot: Balance Tidak Cukup!*\n\n` +
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
