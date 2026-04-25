import dotenv from 'dotenv';
import TelegramBot from 'node-telegram-bot-api';
import OpenAI from 'openai';
import Database from 'better-sqlite3';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

import {
  sanitize,
  getContext,
  jokeHash,
  dedupKey,
  filterCandidates,
  markUsed,
  searchJokes,
  pickBest,
  buildSystemPrompt,
} from './joker-core.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
dotenv.config({ path: resolve(ROOT, '.env') });

// ═══════════════════════════════════════════════════════════
// Config
// ═══════════════════════════════════════════════════════════

const {
  BOT_TOKEN, LLM_API_KEY,
  LLM_BASE_URL = 'https://api.deepseek.com',
  LLM_MODEL = 'deepseek-chat',
  JOKES_FILE = './data/jokes.json',
  DEFAULT_INTERVAL = '100',
  DEFAULT_THRESHOLD = '7',
  DEFAULT_DEDUP_WINDOW = '50',
  PROXY_URL,
} = process.env;

const CFG = {
  interval: parseInt(DEFAULT_INTERVAL, 10),
  threshold: parseInt(DEFAULT_THRESHOLD, 10),
  dedup: parseInt(DEFAULT_DEDUP_WINDOW, 10),
};

// ═══════════════════════════════════════════════════════════
// SQLite Stats
// ═══════════════════════════════════════════════════════════

const DB_PATH = resolve(ROOT, 'data', 'stats.db');
const sdb = new Database(DB_PATH);
sdb.pragma('journal_mode = WAL');
sdb.pragma('synchronous = NORMAL');

sdb.exec(`
  CREATE TABLE IF NOT EXISTS top_jokes (
    chat_id TEXT NOT NULL, joke_text TEXT NOT NULL,
    score REAL NOT NULL, source TEXT DEFAULT '', ts INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS user_stats (
    chat_id TEXT NOT NULL, username TEXT NOT NULL,
    jokes INTEGER DEFAULT 0, messages INTEGER DEFAULT 0,
    PRIMARY KEY (chat_id, username)
  );
  CREATE TABLE IF NOT EXISTS joke_hashes (
    chat_id TEXT NOT NULL, hash TEXT NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s','now')),
    PRIMARY KEY (chat_id, hash)
  );
  CREATE INDEX IF NOT EXISTS idx_top_jokes_score ON top_jokes(chat_id, score DESC);
`);

// Count existing stats
const topJokesCount = sdb.prepare('SELECT COUNT(*) AS cnt FROM top_jokes').get().cnt;
const userStatsCount = sdb.prepare('SELECT COUNT(*) AS cnt FROM user_stats').get().cnt;
info(`SQLITE DB: ${DB_PATH} — ${topJokesCount} top jokes, ${userStatsCount} user stats records`);

const sdbStmts = {
  addTopJoke: sdb.prepare('INSERT INTO top_jokes (chat_id, joke_text, score, source, ts) VALUES (?, ?, ?, ?, ?)'),
  getTopJokes: sdb.prepare('SELECT joke_text, score, source FROM top_jokes WHERE chat_id = ? ORDER BY score DESC LIMIT ?'),
  hasHash: sdb.prepare('SELECT hash FROM joke_hashes WHERE chat_id = ?'),
  addHash: sdb.prepare('INSERT OR IGNORE INTO joke_hashes (chat_id, hash) VALUES (?, ?)'),
  cleanHashes: sdb.prepare("DELETE FROM joke_hashes WHERE created_at < strftime('%s','now','-7 days')"),
  upsertUser: sdb.prepare(`
    INSERT INTO user_stats (chat_id, username, jokes, messages) VALUES (?, ?, ?, ?)
    ON CONFLICT(chat_id, username) DO UPDATE SET jokes=excluded.jokes, messages=excluded.messages
  `),
  getUserStats: sdb.prepare('SELECT username, jokes, messages FROM user_stats WHERE chat_id = ? ORDER BY jokes DESC'),
};

// ═══════════════════════════════════════════════════════════
// Per-chat state (JSON)
// ═══════════════════════════════════════════════════════════

const STATE_FILE = resolve(ROOT, 'data/state.json');

function loadState() {
  if (!existsSync(STATE_FILE)) return { chats: {} };
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf-8')); }
  catch { return { chats: {} }; }
}

function getChatState(chatId) {
  const id = String(chatId);
  if (!state.chats[id]) {
    state.chats[id] = {
      messageCount: 0, jokesToday: 0, tokensSpent: 0,
      lastDay: new Date().toDateString(), usedJokes: [], history: [],
      chatProfile: { style: 'light', users: {} },
      config: { interval: CFG.interval, threshold: CFG.threshold, sources: { jokes: true, bash: true, gen: true } },
    };
  }
  return state.chats[id];
}

const state = loadState();
const flushState = () => writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

// ═══════════════════════════════════════════════════════════
// Jokes (loaded once)
// ═══════════════════════════════════════════════════════════

const JOKES = (() => {
  const path = resolve(ROOT, JOKES_FILE);
  if (!existsSync(path)) {
    info(`JOKES DB: file not found at ${path} — no jokes loaded`);
    return [];
  }
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8'));
    if (!Array.isArray(data) || data.length === 0) {
      info(`JOKES DB: file ${path} is empty or invalid — no jokes loaded`);
      return [];
    }
    info(`JOKES DB: loaded ${data.length} jokes from ${path}`);
    return data;
  } catch (e) {
    info(`JOKES DB: failed to parse ${path} — ${e.message}`);
    return [];
  }
})();

// ═══════════════════════════════════════════════════════════
// LLM
// ═══════════════════════════════════════════════════════════

const openai = new OpenAI({ baseURL: LLM_BASE_URL, apiKey: LLM_API_KEY || process.env.OPENAI_API_KEY });

async function llmCall(system, user, temp) {
  const res = await openai.chat.completions.create({
    model: LLM_MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: temp,
  });
  return res;
}

function trackTokens(res) {
  if (res?.usage?.total_tokens && _cs) {
    _cs.tokensSpent = (_cs.tokensSpent || 0) + res.usage.total_tokens;
  }
}

async function assessJokes(jokes, context) {
  const prompt =
    `Evaluate these jokes against recent chat context. For each, score 0-10 (10 = hilarious and fitting, 0 = not funny). Be critical. Return ONLY valid JSON array: [{ "index": 0, "score": 7, "reason": "..." }]\n\n` +
    `Context:\n${context}\n\nJokes:\n${jokes.map((j, i) => `[${i}] ${sanitize(j.text)}`).join('\n')}`;
  const res = await llmCall('You are a strict comedy judge. Return ONLY valid JSON.', prompt, 0.3);
  trackTokens(res);
  try { return JSON.parse(res.choices[0].message.content); }
  catch { return jokes.map((_, i) => ({ index: i, score: 0 })); }
}

async function generateJokes(context, count, cs, userName) {
  const prompt =
    `Generate ${count} short jokes that fit the following chat context. Return ONLY valid JSON array: [{ "text": "..." }]\n\nContext:\n${context}`;
  const res = await llmCall(buildSystemPrompt(cs.chatProfile.style, userName), prompt, 0.8);
  trackTokens(res);
  try { return JSON.parse(res.choices[0].message.content); }
  catch { return []; }
}

async function adaptJoke(ragJoke, context, cs, userName) {
  const prompt = `Adapt the following base joke to fit the chat context. Keep the spirit. Return ONLY JSON: { "text": "..." }\n\nContext:\n${context}\n\nBase joke:\n${sanitize(ragJoke.text)}`;
  const res = await llmCall(buildSystemPrompt(cs.chatProfile.style, userName), prompt, 0.7);
  trackTokens(res);
  try { return JSON.parse(res.choices[0].message.content); }
  catch { return { text: ragJoke.text }; }
}

// ═══════════════════════════════════════════════════════════
// Core: pick the best joke
// ═══════════════════════════════════════════════════════════

let _cs = null; // global ref for token tracking

async function trySource(candidates, cs, context, chatIdStr, threshold) {
  const dedupSet = new Set(cs.usedJokes.slice(-CFG.dedup));
  const hashDb = new Set(
    sdbStmts.hasHash.all(chatIdStr).map(r => r.hash)
  );
  const unique = filterCandidates(candidates, dedupSet, hashDb);
  if (!unique.length) return null;

  const scores = await assessJokes(unique, context);
  const result = pickBest(scores, unique, threshold);
  if (!result) return null;

  const key = markUsed(cs, hashDb, result.joke.text, CFG.dedup);
  if (key) sdbStmts.addHash.run(chatIdStr, jokeHash(key));
  return result;
}

async function pickBestJoke(chatId, cs, userName) {
  _cs = cs;
  const context = getContext(cs.history);
  const src = cs.config.sources || { jokes: true, bash: true, gen: true };
  const chatIdStr = String(chatId);

  // RAG: jokes + bash
  let candidates = [];
  if (src.jokes || src.bash) {
    for (const rj of searchJokes(JOKES, context, 3)) {
      if (rj.score <= 0) continue;
      const rjSource = rj.tags?.includes('bash') ? 'bash' : 'joke';
      if ((rjSource === 'bash' && !src.bash) || (rjSource === 'joke' && !src.jokes)) continue;
      const adapted = await adaptJoke(rj, context, cs, userName);
      adapted.source = rjSource;
      candidates.push(adapted);
    }
  }

  if (candidates.length) {
    const result = await trySource(candidates, cs, context, chatIdStr, cs.config.threshold);
    if (result) return result;
  }

  // Fallback: LLM generation
  if (!src.gen) return null;
  candidates = await generateJokes(context, 3, cs, userName);
  if (!candidates.length) return null;

  return trySource(candidates, cs, context, chatIdStr, cs.config.threshold);
}

// ═══════════════════════════════════════════════════════════
// Bot: send joke
// ═══════════════════════════════════════════════════════════

async function tryTellJoke(chatId, cs, userName, replyToMsgId) {
  try {
    const result = await pickBestJoke(chatId, cs, userName);
    if (!result) { cs.messageCount--; flushState(); return; }

    const tagMap = { bash: '💻', joke: '📖', gen: '🤖' };
    const replyText = `${result.joke.text} ${tagMap[result.source] || ''}`;
    await bot.sendMessage(chatId, replyText, replyToMsgId ? { reply_to_message_id: replyToMsgId } : {});
    info(`REPLY [chat:${chatId}]: ${replyText.slice(0, 120)}`);

    // Track style
    if (result.score >= 9) cs.chatProfile.style = 'absurd';
    else if (result.score >= 7) cs.chatProfile.style = 'clever';
    else cs.chatProfile.style = 'light';

    cs.jokesToday = (cs.jokesToday || 0) + 1;

    // Save to SQLite
    const chatIdStr = String(chatId);
    sdbStmts.addTopJoke.run(chatIdStr, result.joke.text, result.score, result.source || '', Date.now());
    if (cs.history.length) {
      const last = cs.history[cs.history.length - 1];
      const userData = last && cs.chatProfile.users[last.fromUserKey];
      if (userData) {
        userData.jokes = (userData.jokes || 0) + 1;
        sdbStmts.upsertUser.run(chatIdStr, last.fromUserKey, userData.jokes, userData.messages || 0);
      }
    }
    flushState();
  } catch (e) {
    error('tryTellJoke ERROR:', e.message, e.stack);
  }
}

// ═══════════════════════════════════════════════════════════
// Bot: commands
// ═══════════════════════════════════════════════════════════

const SRC_LABELS = { jokes: '📖 Анекдоты', bash: '💻 Башорг', gen: '🤖 LLM' };
const SRC_KEYS = { a: 'jokes', b: 'bash', l: 'gen' };

function isAdmin(msg) {
  return msg.from?.username && process.env.ADMIN_USERNAMES?.split(',').map(s => s.trim().toLowerCase()).includes(msg.from.username.toLowerCase());
}

function handleCommand(msg) {
  const chatId = msg.chat.id;
  const text = msg.text || '';
  const cs = getChatState(chatId);

  // Strip bot mention for command matching
  const botUsername = (bot._botInfo || { username: 'JockerOCCBot' }).username?.toLowerCase();
  const cleanText = text.replace(new RegExp('@' + botUsername, 'gi'), '').trim();

  // /id — anyone can use
  if (/^\/j?id$/.test(text) || /^\/j?id$/.test(cleanText)) {
    const title = msg.chat.title || msg.chat.username || 'private';
    const reply = `🆔 Chat: ${chatId}\nTitle: ${title}`;
    bot.sendMessage(chatId, reply);
    info(`REPLY [${title}]: /id → ${chatId}`);
    return true;
  }

  if (!isAdmin(msg)) {
    bot.sendMessage(chatId, '❌ Только админ может менять настройки');
    return true;
  }

  // /config
  if (/^\/j?config$/.test(text)) {
    const c = cs.config;
    const sources = Object.entries(c.sources).map(([k, v]) => `${SRC_LABELS[k] || k}: ${v ? '✅' : '❌'}`).join(', ');
    bot.sendMessage(chatId, `📋 Настройки чата:\n• Интервал: ${c.interval} сообщ.\n• Порог: ${c.threshold}/10\n• Источники: ${sources}\n\n/interval N, /threshold N, /source a|b|l on|off`);
    return true;
  }

  // /source
  const sm = text.match(/^\/j?source\s+([abl])\s+(on|off)$/);
  if (sm) {
    const key = SRC_KEYS[sm[1]];
    cs.config.sources[key] = sm[2] === 'on';
    flushState();
    bot.sendMessage(chatId, `✅ ${SRC_LABELS[key]}: ${sm[2] === 'on' ? 'включён' : 'выключен'}`);
    return true;
  }

  // /stats
  if (/^\/j?(stats|top)$/.test(text)) {
    const chatIdStr = String(chatId);
    const users = sdbStmts.getUserStats.all(chatIdStr);
    const topJokes = sdbStmts.getTopJokes.all(chatIdStr, 3);
    const tagMap = { bash: '💻', joke: '📖', gen: '🤖' };
    let msg = `📊 Статистика чата\nШуток сегодня: ${cs.jokesToday || 0}\nВсего сообщений: ${cs.messageCount}\nТокенов потрачено: ~${cs.tokensSpent || 0}\n\n`;
    if (users.length) {
      msg += '👤 Топ насмешников:\n' + users.slice(0, 5).map((r, i) => `${i + 1}. ${r.username} — ${r.jokes} шуток / ${r.messages} сообщ.`).join('\n') + '\n\n';
    }
    if (topJokes.length) {
      msg += '🏆 Топ шуток:\n' + topJokes.map((r, i) => `${i + 1}. ${r.joke_text.slice(0, 150)} (${r.score}/10) ${tagMap[r.source] || ''}`).join('\n');
    }
    bot.sendMessage(chatId, msg);
    return true;
  }

  // /interval
  const im = text.match(/^\/j?interval\s+(\d+)$/);
  if (im && parseInt(im[1]) >= 1) {
    cs.config.interval = parseInt(im[1], 10);
    cs.messageCount = 0;
    flushState();
    bot.sendMessage(chatId, `✅ Интервал изменён: каждые ${cs.config.interval} сообщений`);
    return true;
  }

  // /threshold
  const tm = text.match(/^\/j?threshold\s+(\d+)$/);
  if (tm) {
    const v = parseInt(tm[1], 10);
    if (v < 1 || v > 10) { bot.sendMessage(chatId, '❌ От 1 до 10'); return true; }
    cs.config.threshold = v;
    flushState();
    bot.sendMessage(chatId, `✅ Порог изменён: ${v}/10`);
    return true;
  }

  // Help
  bot.sendMessage(chatId, 'Команды:\n/config — настройки чата\n/interval N — интервал (сообщ.)\n/threshold N — порог качества (1-10)\n/source a|b|l on|off — источники\n/stats — статистика');
  return true;
}

// ═══════════════════════════════════════════════════════════
// Bot: message handler
// ═══════════════════════════════════════════════════════════

async function onMessage(msg) {
  const chatId = msg.chat.id;
  const text = msg.text || msg.caption || '';
  if (!text) return;

  const cs = getChatState(chatId);
  const title = msg.chat.title || msg.chat.username || (msg.chat.first_name || '') + ' ' + (msg.chat.last_name || '') || 'private';
  const fromName = msg.from?.first_name || msg.from?.username || 'unknown';
  const fromUser = msg.from?.username ? `@${msg.from.username}` : fromName;
  info(`[${title}] <${fromUser}> ${text.slice(0, 120)}`);

  const userName = msg.from?.first_name || msg.from?.username || 'User';
  const userKey = msg.from?.username || msg.from?.first_name || 'unknown';
  const botUsername = (bot._botInfo || { username: 'JockerOCCBot' }).username?.toLowerCase();
  const isMention = text.toLowerCase().includes('@' + botUsername);
  const isReplyToBot = msg.reply_to_message?.from?.is_bot;

  // Commands — check both bare commands and mention+command
  const cmdPrefix = /^\/(j?config|j?interval|j?threshold|j?source|j?stats|j?top|id)/;
  const cleanText = text.replace(new RegExp('@' + botUsername, 'gi'), '').trim();
  if (cmdPrefix.test(text) || cmdPrefix.test(cleanText)) { handleCommand(msg); return; }

  // History
  cs.history.push({ from: fromName, fromUserKey: userKey, text, ts: Date.now() });
  if (cs.history.length > 100) cs.history = cs.history.slice(-100);

  // Day rollover
  const today = new Date().toDateString();
  if (cs.lastDay !== today) { cs.jokesToday = 0; cs.lastDay = today; }

  cs.messageCount++;

  // User tracking
  if (!cs.chatProfile.users[userKey]) cs.chatProfile.users[userKey] = { messages: 0, jokes: 0 };
  cs.chatProfile.users[userKey].messages++;
  sdbStmts.upsertUser.run(String(chatId), userKey, cs.chatProfile.users[userKey].jokes, cs.chatProfile.users[userKey].messages);

  // Triggers
  const replyToMsgId = isMention || isReplyToBot ? msg.message_id : null;
  if (isMention || isReplyToBot) {
    info(`TRIGGER: mention/reply [${title}]`);
    tryTellJoke(chatId, cs, userName, replyToMsgId);
  }
  if (cs.messageCount % cs.config.interval === 0) {
    info(`TRIGGER: interval [${title}]`);
    tryTellJoke(chatId, cs, userName, null);
  }

  flushState();
}

// ═══════════════════════════════════════════════════════════
// Observability (must be before any usage)
// ═══════════════════════════════════════════════════════════

function log(level, msg) {
  const line = `${new Date().toISOString()} ${level.padEnd(5)} ${msg}`;
  (level === 'ERROR' ? process.stderr : process.stdout).write(line + '\n');
}
const info = (...a) => log('INFO', a.map(v => typeof v === 'object' ? JSON.stringify(v) : v).join(' '));
const error = (...a) => log('ERROR', a.map(v => typeof v === 'object' ? JSON.stringify(v) : v).join(' '));

process.on('unhandledRejection', (err) => error('UNHANDLED REJECTION:', err.message, err.stack));
process.on('uncaughtException', (err) => { error('UNCAUGHT EXCEPTION:', err.message, err.stack); process.exit(1); });

// ═══════════════════════════════════════════════════════════
// Init
// ═══════════════════════════════════════════════════════════

if (!BOT_TOKEN) { error('❌ BOT_TOKEN is required.'); process.exit(1); }
if (!LLM_API_KEY && !process.env.OPENAI_API_KEY) { error('❌ LLM_API_KEY is required.'); process.exit(1); }

const botOptions = { polling: true };
if (PROXY_URL) {
  info(`Using proxy: ${PROXY_URL}`);
  botOptions.request = { proxy: PROXY_URL };
}
const bot = new TelegramBot(BOT_TOKEN, botOptions);
bot.on('message', onMessage);

info(`Jocker Bot started. Interval: ${CFG.interval}, threshold: ${CFG.threshold}`);

sdbStmts.cleanHashes.run();
setInterval(() => { try { sdbStmts.cleanHashes.run(); } catch (e) { error('hash cleanup:', e.message); } }, 3600000);
