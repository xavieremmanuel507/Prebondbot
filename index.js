import { Bot, InlineKeyboard } from "grammy";
import WebSocket from "ws";
import fetch from "node-fetch";

const BOT_TOKEN     = process.env.BOT_TOKEN;
const CHAT_ID       = process.env.CHAT_ID;
const MIN_BOND_PCT  = parseFloat(process.env.MIN_BOND_PCT || "0");
const MAX_BOND_PCT  = parseFloat(process.env.MAX_BOND_PCT || "85");

if (!BOT_TOKEN || !CHAT_ID) {
  console.error("❌ BOT_TOKEN and CHAT_ID must be set.");
  process.exit(1);
}

const bot = new Bot(BOT_TOKEN);
let foundTotal = 0;
const BOND_TARGET = 793_100_000_000;

// Watchlist: mint => { symbol, name, seenAt, checked2h, checked24h }
const watchlist = new Map();

async function fetchTokenDetails(mint) {
  const endpoints = [
    `https://frontend-api.pump.fun/coins/${mint}`,
    `https://client-api-2-74b1891ee9f9.herokuapp.com/coins/${mint}`,
  ];
  for (const url of endpoints) {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "Accept": "application/json",
          "Origin": "https://pump.fun",
          "Referer": "https://pump.fun/",
        },
        timeout: 8000,
      });
      if (!res.ok) continue;
      const data = await res.json();
      if (data && data.mint) return data;
    } catch (e) {}
  }
  return null;
}

function getBondPct(token) {
  const val = token.vSolInBondingCurve || token.virtual_sol_reserves || 0;
  return Math.min(100, (val / BOND_TARGET) * 100);
}

function formatMcap(v) {
  if (!v) return "—";
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000)     return `$${(v / 1_000).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

function bondBar(pct) {
  const filled = Math.round(pct / 10);
  return "█".repeat(filled) + "░".repeat(10 - filled);
}

function bondEmoji(pct) {
  if (pct >= 70) return "🔥";
  if (pct >= 40) return "⚡";
  return "🟢";
}

function cleanUrl(raw) {
  if (!raw) return null;
  const s = raw.trim();
  if (s.startsWith("http")) return s;
  return `https://t.me/${s.replace(/^@/, "")}`;
}

function escMd(str = "") {
  return str.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
}

function hasSocials(token) {
  return (token.telegram && token.telegram.trim().length > 0) ||
         (token.discord  && token.discord.trim().length  > 0) ||
         (token.website  && token.website.trim().length  > 0);
}

async function sendAlert(t, checkLabel) {
  const pct        = getBondPct(t);
  const pumpUrl    = `https://pump.fun/coin/${t.mint}`;
  const tgUrl      = t.telegram ? cleanUrl(t.telegram) : null;
  const discordUrl = t.discord  ? cleanUrl(t.discord)  : null;
  const webUrl     = t.website  ? cleanUrl(t.website)  : null;

  const lines = [
    `🔭 *PreBond Token — ${escMd(checkLabel)} Check*`,
    ``,
    `🪙 *${escMd(t.name)}* — \`$${escMd(t.symbol)}\``,
    ``,
    `${bondEmoji(pct)} Bond: \`${pct.toFixed(1)}%\``,
    `\`[${bondBar(pct)}]\``,
    ``,
    `💰 MCap: \`${formatMcap(t.market_cap || t.marketCapSol)}\``,
    `💬 Replies: \`${t.reply_count || t.replyCount || 0}\``,
    ``,
    `📋 \`${t.mint}\``,
  ];

  if (t.description) {
    const desc = t.description.slice(0, 120);
    lines.push(``, `📝 ${escMd(desc)}${t.description.length > 120 ? "…" : ""}`);
  }

  const keyboard = new InlineKeyboard().url("🔗 pump.fun", pumpUrl);
  if (tgUrl)      keyboard.url("✈️ Telegram", tgUrl);
  if (discordUrl) keyboard.url("💬 Discord", discordUrl);
  if (webUrl)     keyboard.url("🌐 Website", webUrl);

  try {
    await bot.api.sendMessage(CHAT_ID, lines.join("\n"), {
      parse_mode: "MarkdownV2",
      reply_markup: keyboard,
      disable_web_page_preview: true,
    });
    foundTotal++;
    console.log(`✅ Alert sent [${checkLabel}]: ${t.symbol}`);
  } catch (err) {
    console.error(`❌ Alert failed for ${t.mint}:`, err.message);
  }
}

function sleep(ms) {
  return new Promise(res => setTimeout(res, ms));
}

async function runChecks() {
  const now = Date.now();
  const TWO_HOURS    = 2  * 60 * 60 * 1000;
  const TWENTY_FOUR  = 24 * 60 * 60 * 1000;
  const TWENTY_FIVE  = 25 * 60 * 60 * 1000;

  const toCheck = [];

  for (const [mint, entry] of watchlist.entries()) {
    const age = now - entry.seenAt;

    // Clean up tokens older than 25 hours
    if (age > TWENTY_FIVE) {
      watchlist.delete(mint);
      continue;
    }

    // 2 hour check
    if (!entry.checked2h && age >= TWO_HOURS) {
      toCheck.push({ mint, label: "2hr" });
      continue;
    }

    // 24 hour check
    if (!entry.checked24h && age >= TWENTY_FOUR) {
      toCheck.push({ mint, label: "24hr" });
    }
  }

  console.log(`⏰ Running checks — ${toCheck.length} tokens due | Watchlist: ${watchlist.size}`);

  for (const { mint, label } of toCheck) {
    await sleep(1200);
    const token = await fetchTokenDetails(mint);

    if (!token) {
      console.log(`⚠️ Could not fetch ${mint}`);
      if (label === "2hr")  watchlist.get(mint) && (watchlist.get(mint).checked2h  = true);
      if (label === "24hr") watchlist.get(mint) && (watchlist.get(mint).checked24h = true);
      continue;
    }

    // Mark as checked
    const entry = watchlist.get(mint);
    if (entry) {
      if (label === "2hr")  entry.checked2h  = true;
      if (label === "24hr") entry.checked24h = true;
    }

    const bonded = token.complete === true || token.raydium_pool != null;
    const pct    = getBondPct(token);

    console.log(`[${label}] ${token.symbol} | Bonded: ${bonded} | Socials: ${hasSocials(token)} | Bond: ${pct.toFixed(1)}%`);

    // Skip if already bonded or outside bond range
    if (bonded || pct < MIN_BOND_PCT || pct > MAX_BOND_PCT) continue;

    // Alert if has socials
    if (hasSocials(token)) {
      await sendAlert(token, label === "2hr" ? "2 Hour" : "24 Hour");
    }
  }
}

function connectWebSocket() {
  console.log("🔌 Connecting to PumpPortal...");

  const ws = new WebSocket("wss://pumpportal.fun/api/data", {
    headers: {
      "Origin": "https://pump.fun",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    }
  });

  ws.on("open", () => {
    console.log("✅ Connected to PumpPortal!");
    ws.send(JSON.stringify({ method: "subscribeNewToken" }));
  });

  ws.on("message", async (data) => {
    try {
      const token = JSON.parse(data.toString());
      if (!token.mint) return;
      if (watchlist.has(token.mint)) return;

      watchlist.set(token.mint, {
        symbol:     token.symbol,
        name:       token.name,
        seenAt:     Date.now(),
        checked2h:  false,
        checked24h: false,
      });

      console.log(`➕ Watching: ${token.symbol} | Watchlist: ${watchlist.size}`);
    } catch (e) {}
  });

  ws.on("close", () => {
    console.log("⚠️ Disconnected — reconnecting in 5s...");
    setTimeout(connectWebSocket, 5000);
  });

  ws.on("error", (err) => {
    console.error("❌ WebSocket error:", err.message);
  });
}

bot.command("start", async (ctx) => {
  await ctx.reply(
    "👋 *PreBond Scanner Bot*\n\n" +
    "I watch every new pump\\.fun token and check them at *2 hours* and *24 hours*\\.\n\n" +
    "If they're still unbonded and have Telegram, Discord or Website — I alert you\\.\n\n" +
    "/status \\— show stats\n" +
    "/config \\— show settings",
    { parse_mode: "MarkdownV2" }
  );
});

bot.command("status", async (ctx) => {
  await ctx.reply(
    `📊 *Scanner Status*\n\n` +
    `✅ Running via PumpPortal\n` +
    `👁 Watching: \`${watchlist.size}\` tokens\n` +
    `📢 Alerts sent: \`${foundTotal}\``,
    { parse_mode: "MarkdownV2" }
  );
});

bot.command("config", async (ctx) => {
  await ctx.reply(
    `⚙️ *Current Config*\n\n` +
    `Bond range: \`${MIN_BOND_PCT}% – ${MAX_BOND_PCT}%\`\n` +
    `Checks: \`2 hours + 24 hours after launch\``,
    { parse_mode: "MarkdownV2" }
  );
});

async function main() {
  console.log("🚀 PreBond Scanner Bot starting...");
  console.log(`📊 Bond filter: ${MIN_BOND_PCT}% – ${MAX_BOND_PCT}%`);
  console.log(`📤 Sending to chat: ${CHAT_ID}`);

  bot.start({ drop_pending_updates: true });
  console.log("✅ Bot listening for commands...");

  await sleep(2000);
  connectWebSocket();

  // Run checks every 10 minutes
  setInterval(runChecks, 10 * 60 * 1000);

  // First check after 5 minutes
  setTimeout(runChecks, 5 * 60 * 1000);
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
