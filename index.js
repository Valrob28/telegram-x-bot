import fs from "fs";
import fetch from "node-fetch";

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN?.trim();
const CHAT_ID_RAW = process.env.CHAT_ID?.trim();
const CHAT_ID =
  CHAT_ID_RAW && /^-?\d+$/.test(CHAT_ID_RAW) ? Number(CHAT_ID_RAW) : CHAT_ID_RAW;

// --- X à suivre : https://x.com/Nodz_io — notifications à partir du 25 mars 2026 ---
const RSS_URL = "https://rsshub.app/twitter/user/Nodz_io";
const MONITOR_SINCE = new Date("2026-03-25T00:00:00.000Z");

// --- ROADMAP (fichier local en CI = toujours à jour après checkout ; fallback raw GitHub en local sans clone) ---
const ROADMAP_FILE = "ROADMAP.md";
const ROADMAP_URL = "https://raw.githubusercontent.com/Valrob28/telegram-x-bot/main/ROADMAP.md";

// --- Fichiers locaux ---
const TWEETS_FILE = "tweets.json";
const ROADMAP_HASH_FILE = "roadmap_hash.txt";

function repoWebUrl() {
  const gh = process.env.GITHUB_REPOSITORY;
  return gh ? `https://github.com/${gh}` : "https://github.com/Valrob28/telegram-x-bot";
}

/** Telegram HTML : seuls &, <, > à échapper dans le corps. */
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const TELEGRAM_MAX_MESSAGE = 4096;

// ========== UTILS ==========
function loadTweets() {
  if (!fs.existsSync(TWEETS_FILE)) return [];
  return JSON.parse(fs.readFileSync(TWEETS_FILE));
}

function saveTweets(tweets) {
  fs.writeFileSync(TWEETS_FILE, JSON.stringify(tweets, null, 2));
}

/**
 * @param {string} message
 * @param {{ parse_mode?: "HTML"; disable_web_page_preview?: boolean }} [opts]
 */
async function sendTelegram(message, opts = {}) {
  if (!TELEGRAM_TOKEN || CHAT_ID === undefined || CHAT_ID === "") {
    throw new Error("Missing TELEGRAM_TOKEN or CHAT_ID");
  }
  if (message.length > TELEGRAM_MAX_MESSAGE) {
    message =
      message.slice(0, TELEGRAM_MAX_MESSAGE - 40) + "\n\n<i>… (message tronqué, limite Telegram)</i>";
  }
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  const body = {
    chat_id: CHAT_ID,
    text: message,
    ...(opts.parse_mode && { parse_mode: opts.parse_mode }),
    ...(opts.disable_web_page_preview !== undefined && {
      disable_web_page_preview: opts.disable_web_page_preview
    })
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) {
    console.error("Telegram sendMessage failed:", JSON.stringify(data));
    throw new Error(data.description || `Telegram API error HTTP ${res.status}`);
  }
  console.log("Telegram OK, message_id:", data.result?.message_id);
}

// ========== TWEETS ==========
async function getLatestTweet() {
  const res = await fetch(RSS_URL);
  const text = await res.text();
  const matchItem = text.match(/<item>([\s\S]*?)<\/item>/);
  if (!matchItem) return null;
  const item = matchItem[1];

  const title = item.match(/<title>(.*?)<\/title>/)?.[1] || "";
  const link = item.match(/<link>(.*?)<\/link>/)?.[1] || "";
  const pubDate = item.match(/<pubDate>(.*?)<\/pubDate>/)?.[1] || "";
  const idMatch = link.match(/status\/(\d+)/);
  const id = idMatch ? idMatch[1] : Date.now().toString();

  return { id, text: title, url: link, date: new Date(pubDate).toISOString(), likes: 0, retweets: 0, views: 0 };
}

function computeInsight(tweet, tweets) {
  if (tweets.length === 0) return "🆕 First tweet tracked";
  const avgLikes = tweets.reduce((sum, t) => sum + (t.likes || 0), 0) / tweets.length;
  if (avgLikes === 0) return "🧊 No data yet";
  const score = tweet.likes / avgLikes;
  if (score > 2) return "🚀 This tweet is outperforming hard";
  if (score > 1.2) return "⚡ Strong engagement";
  return "🧊 Slow start";
}

function formatTweetMessageHtml(tweet, insight) {
  const t = escapeHtml(tweet.text);
  const u = escapeHtml(tweet.url);
  const ins = escapeHtml(insight);
  return (
    `<b>🟣 NODZ // CONTENT PIPELINE</b>\n\n` +
    `<b>Nouveau signal sur X</b>\n` +
    `<blockquote>${t}</blockquote>\n` +
    `🔗 <a href="${u}">Ouvrir le tweet</a>\n\n` +
    `━━━━━━━━━━━━━━━\n\n` +
    `<b>📊 Métriques</b>\n` +
    `❤️ ${tweet.likes} · 🔁 ${tweet.retweets} · 👁️ ${tweet.views}\n\n` +
    `<b>🧠 Insight</b>\n` +
    `${ins}\n\n` +
    `<i>— NODZ monitoring</i>`
  );
}

async function processTweets() {
  const tweets = loadTweets();
  const latest = await getLatestTweet();
  if (!latest) return console.log("No tweet found (RSS vide ou format inattendu)");
  console.log("Latest tweet id from RSS:", latest.id, "date:", latest.date);
  const exists = tweets.find(t => t.id === latest.id);
  if (!exists) {
    const tweetTime = new Date(latest.date);
    if (Number.isNaN(tweetTime.getTime()) || tweetTime < MONITOR_SINCE) {
      tweets.push(latest);
      saveTweets(tweets);
      console.log("Tweet before monitor window, tracked without notify");
      return;
    }
    const insight = computeInsight(latest, tweets);
    await sendTelegram(formatTweetMessageHtml(latest, insight), {
      parse_mode: "HTML",
      disable_web_page_preview: true
    });
    tweets.push(latest);
    saveTweets(tweets);
    console.log("New tweet sent");
  } else {
    console.log("Already processed (aucun nouvel envoi Telegram pour ce tweet)");
  }
}

// ========== ROADMAP ==========
async function loadRoadmapText() {
  if (fs.existsSync(ROADMAP_FILE)) {
    return fs.readFileSync(ROADMAP_FILE, "utf8");
  }
  const res = await fetch(ROADMAP_URL);
  if (!res.ok) {
    throw new Error(
      `ROADMAP inaccessible (${res.status}): ${ROADMAP_URL} — vérifie que le repo est public ou ajoute ${ROADMAP_FILE} localement.`
    );
  }
  return res.text();
}

function hashString(str) {
  let hash = 0, i, chr;
  if (str.length === 0) return hash;
  for (i = 0; i < str.length; i++) {
    chr = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + chr;
    hash |= 0;
  }
  return hash.toString();
}

async function processRoadmap() {
  let roadmap;
  try {
    roadmap = await loadRoadmapText();
  } catch (e) {
    console.error(e.message || e);
    throw e;
  }
  if (roadmap.trim().startsWith("404:")) {
    throw new Error("Contenu roadmap invalide (404) — utiliser ROADMAP.md en local ou corriger l’URL.");
  }
  const hash = hashString(roadmap);
  const prevHash = fs.existsSync(ROADMAP_HASH_FILE) ? fs.readFileSync(ROADMAP_HASH_FILE, "utf8") : "";
  if (hash !== prevHash) {
    const web = repoWebUrl();
    const safeWeb = escapeHtml(web);
    let body = escapeHtml(roadmap);
    const header = `🗓️ <b>NODZ ROADMAP UPDATED</b>\n\n<pre>`;
    const footer = `</pre>\n\n<a href="${safeWeb}">📎 Voir le dépôt sur GitHub</a>`;
    const budget = TELEGRAM_MAX_MESSAGE - header.length - footer.length - 80;
    if (body.length > budget) {
      body = body.slice(0, Math.max(0, budget - 20)) + "\n…";
    }
    await sendTelegram(header + body + footer, {
      parse_mode: "HTML",
      disable_web_page_preview: false
    });
    fs.writeFileSync(ROADMAP_HASH_FILE, hash);
    console.log("Roadmap sent");
  } else {
    console.log("Roadmap unchanged");
  }
}

// ========== MAIN ==========
async function main() {
  console.log(
    "Env: TELEGRAM_TOKEN=",
    TELEGRAM_TOKEN ? "set" : "MISSING",
    "CHAT_ID=",
    CHAT_ID !== undefined && CHAT_ID !== "" ? "set" : "MISSING"
  );
  await processTweets();
  await processRoadmap();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
