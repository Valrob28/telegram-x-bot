import fs from "fs";
import fetch from "node-fetch";

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN?.trim();
const CHAT_ID_RAW = process.env.CHAT_ID?.trim();
const CHAT_ID =
  CHAT_ID_RAW && /^-?\d+$/.test(CHAT_ID_RAW) ? Number(CHAT_ID_RAW) : CHAT_ID_RAW;

// --- X à suivre : https://x.com/Nodz_io — notifications à partir du 25 mars 2026 ---
// RSS_URL (secret GitHub) : ex. RSSHub self-hosted, ou Nitter https://TON_INSTANCE/Nodz_io/rss
// (les instances Nitter publiques sont souvent derrière Cloudflare → inutilisables depuis les CI).
// Défaut rsshub.app/twitter : souvent une 404 publique pour Twitter.
const RSS_URL =
  process.env.RSS_URL?.trim() || "https://rsshub.app/twitter/user/Nodz_io";
const MONITOR_SINCE = new Date("2026-03-25T00:00:00.000Z");

// --- ROADMAP (fichier local en CI = toujours à jour après checkout ; fallback raw GitHub en local sans clone) ---
const ROADMAP_FILE = "ROADMAP.md";
const ROADMAP_URL = "https://raw.githubusercontent.com/Valrob28/telegram-x-bot/main/ROADMAP.md";

// --- Fichiers locaux ---
const TWEETS_FILE = "tweets.json";
const ROADMAP_HASH_FILE = "roadmap_hash.txt";
/** Dernier message roadmap épinglé (pour le remplacer au prochain envoi). */
const ROADMAP_PIN_ID_FILE = "roadmap_pin_id.txt";

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
  const mid = data.result?.message_id;
  console.log("Telegram OK, message_id:", mid);
  return mid;
}

function pinRoadmapEnabled() {
  const v = (process.env.PIN_ROADMAP || "").toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

async function telegramApi(method, extra = {}) {
  if (!TELEGRAM_TOKEN || CHAT_ID === undefined || CHAT_ID === "") {
    throw new Error("Missing TELEGRAM_TOKEN or CHAT_ID");
  }
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/${method}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT_ID, ...extra })
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) {
    throw new Error(data.description || `${method} failed`);
  }
  return data;
}

/** Épingle le message (le bot doit être admin avec « épingler les messages »). */
async function pinRoadmapMessage(messageId) {
  await telegramApi("pinChatMessage", {
    message_id: messageId,
    disable_notification: true
  });
  console.log("Roadmap épinglée, message_id:", messageId);
}

async function unpinRoadmapMessage(messageId) {
  await telegramApi("unpinChatMessage", { message_id: messageId });
  console.log("Ancienne roadmap désépinglée, message_id:", messageId);
}

// ========== TWEETS ==========
function stripCdata(s) {
  return String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim();
}

function itemToTweet(titleRaw, linkRaw, dateRaw) {
  const title = stripCdata(titleRaw);
  const link = stripCdata(linkRaw).trim();
  const pubDate = stripCdata(dateRaw);
  const idMatch = link.match(/status\/(\d+)/);
  const id = idMatch ? idMatch[1] : Date.now().toString();
  const date = pubDate ? new Date(pubDate) : new Date();
  const iso = Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
  return { id, text: title, url: link, date: iso, likes: 0, retweets: 0, views: 0 };
}

/** Premier <item> (RSS 2.0, ex. Nitter en RSS). */
function parseFirstRssItem(xml) {
  const m = xml.match(/<item>([\s\S]*?)<\/item>/);
  if (!m) return null;
  const item = m[1];
  const title = item.match(/<title>([\s\S]*?)<\/title>/)?.[1] || "";
  const link = item.match(/<link>([\s\S]*?)<\/link>/)?.[1] || "";
  const pubDate =
    item.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] ||
    item.match(/<dc:date>([\s\S]*?)<\/dc:date>/)?.[1] ||
    "";
  if (!link && !title) return null;
  return itemToTweet(title, link, pubDate);
}

/** Premier <entry> (Atom, certains agrégateurs / variantes). */
function parseFirstAtomEntry(xml) {
  const m = xml.match(/<entry>([\s\S]*?)<\/entry>/);
  if (!m) return null;
  const entry = m[1];
  const title = entry.match(/<title[^>]*>([\s\S]*?)<\/title>/)?.[1] || "";
  let link =
    entry.match(/<link[^>]+href="([^"]+)"[^>]*\/>/)?.[1] ||
    entry.match(/<link[^>]+href="([^"]+)"[^>]*>/)?.[1] ||
    entry.match(/<link>([\s\S]*?)<\/link>/)?.[1] ||
    "";
  const pub =
    entry.match(/<published>([\s\S]*?)<\/published>/)?.[1] ||
    entry.match(/<updated>([\s\S]*?)<\/updated>/)?.[1] ||
    "";
  if (!link && !title) return null;
  return itemToTweet(title, link, pub);
}

async function getLatestTweet() {
  const res = await fetch(RSS_URL, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; NodzBot/1.0; +https://github.com/Valrob28/telegram-x-bot)",
      Accept: "application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.8"
    },
    redirect: "follow"
  });
  const text = await res.text();
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  console.log("RSS:", res.status, res.statusText, "type:", ct || "?", "len:", text.length);

  const fromRss = parseFirstRssItem(text);
  if (fromRss) return fromRss;
  const fromAtom = parseFirstAtomEntry(text);
  if (fromAtom) return fromAtom;

  const flat = text.slice(0, 350).replace(/\s+/g, " ");
  console.log(
    "Pas de flux RSS/Atom exploitable (<item> ou <entry>). " +
      "rsshub.app/public et beaucoup d’instances Nitter renvoient 404 ou du HTML (Cloudflare). " +
      "Utilise une RSS_URL qui répond en XML depuis le runner (RSSHub perso, proxy, etc.). " +
      "Nitter théorique : https://INSTANCE/Nodz_io/rss pour https://x.com/Nodz_io — " +
      "Aperçu:",
    flat
  );
  return null;
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
    const messageId = await sendTelegram(header + body + footer, {
      parse_mode: "HTML",
      disable_web_page_preview: false
    });
    fs.writeFileSync(ROADMAP_HASH_FILE, hash);
    console.log("Roadmap sent");

    if (pinRoadmapEnabled() && messageId != null) {
      try {
        if (fs.existsSync(ROADMAP_PIN_ID_FILE)) {
          const old = parseInt(fs.readFileSync(ROADMAP_PIN_ID_FILE, "utf8").trim(), 10);
          if (!Number.isNaN(old)) {
            try {
              await unpinRoadmapMessage(old);
            } catch (e) {
              console.log("Désépinglage ignoré:", e.message || e);
            }
          }
        }
        await pinRoadmapMessage(messageId);
        fs.writeFileSync(ROADMAP_PIN_ID_FILE, String(messageId));
      } catch (e) {
        console.error(
          "Épinglage impossible — mets le bot admin avec « Épingler les messages » :",
          e.message || e
        );
      }
    }
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
    CHAT_ID !== undefined && CHAT_ID !== "" ? "set" : "MISSING",
    "PIN_ROADMAP=",
    pinRoadmapEnabled() ? "on" : "off"
  );
  console.log("RSS_URL =", RSS_URL);
  await processTweets();
  await processRoadmap();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
