import dotenv from 'dotenv';
import TelegramBot from 'node-telegram-bot-api';
import OpenAI from 'openai';
import Database from 'better-sqlite3';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
dotenv.config({ path: resolve(ROOT, '.env') });

if (!process.env.LLM_API_KEY && !process.env.OPENAI_API_KEY) {
  error('❌ LLM_API_KEY or OPENAI_API_KEY is required.');
  process.exit(1);
}

// ─── Global config ────────────────────────────────────────
const {
  BOT_TOKEN,
  LLM_API_KEY,
  LLM_BASE_URL = 'https://api.deepseek.com',
  LLM_MODEL = 'deepseek-chat',
  JOKES_FILE = './data/jokes.json',
  DEFAULT_INTERVAL = '100',
  DEFAULT_THRESHOLD = '7',
  DEFAULT_DEDUP_WINDOW = '50',
} = process.env;

const CFG = {
  defaultInterval: parseInt(DEFAULT_INTERVAL, 10),
  defaultThreshold: parseInt(DEFAULT_THRESHOLD, 10),
  dedup: parseInt(DEFAULT_DEDUP_WINDOW, 10),
};

// ─── Stats DB (SQLite) ────────────────────────────────────
const DB_PATH = resolve(ROOT, 'data', 'stats.db');
const sdb = new Database(DB_PATH);
sdb.pragma('journal_mode = WAL');
sdb.pragma('synchronous = NORMAL');

sdb.exec(`
  CREATE TABLE IF NOT EXISTS top_jokes (
    chat_id TEXT NOT NULL,
    joke_text TEXT NOT NULL,
    score REAL NOT NULL,
    source TEXT DEFAULT '',
    ts INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS user_stats (
    chat_id TEXT NOT NULL,
    username TEXT NOT NULL,
    jokes INTEGER DEFAULT 0,
    messages INTEGER DEFAULT 0,
    PRIMARY KEY (chat_id, username)
  );
  CREATE INDEX IF NOT EXISTS idx_top_jokes_score ON top_jokes(chat_id, score DESC);
  CREATE TABLE IF NOT EXISTS joke_hashes (
    chat_id TEXT NOT NULL,
    hash TEXT NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s','now')),
    PRIMARY KEY (chat_id, hash)
  );
`);

const sdbStmts = {
  addTopJoke: sdb.prepare('INSERT INTO top_jokes (chat_id, joke_text, score, source, ts) VALUES (?, ?, ?, ?, ?)'),
  getTopJokes: sdb.prepare('SELECT joke_text, score, source FROM top_jokes WHERE chat_id = ? ORDER BY score DESC LIMIT ?'),
  addHash: sdb.prepare('INSERT OR IGNORE INTO joke_hashes (chat_id, hash) VALUES (?, ?)'),
  hasHash: sdb.prepare('SELECT 1 FROM joke_hashes WHERE chat_id = ? AND hash = ?'),
  cleanHashes: sdb.prepare("DELETE FROM joke_hashes WHERE created_at < strftime('%s','now','-7 days')"),
  upsertUser: sdb.prepare(`
    INSERT INTO user_stats (chat_id, username, jokes, messages)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(chat_id, username) DO UPDATE SET
      jokes = excluded.jokes,
      messages = excluded.messages
  `),
  getUserStats: sdb.prepare('SELECT username, jokes, messages FROM user_stats WHERE chat_id = ? ORDER BY jokes DESC'),
};

// ─── Per-chat state (JSON) ────────────────────────────────
const STATE_FILE = resolve(ROOT, 'data/state.json');

function loadState() {
  if (!existsSync(STATE_FILE)) return { chats: {} };
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
  } catch {
    return { chats: {} };
  }
}

function getChatState(chatId) {
  const id = String(chatId);
  if (!state.chats[id]) {
    state.chats[id] = {
      messageCount: 0,
      jokesToday: 0,
      tokensSpent: 0,
      lastDay: new Date().toDateString(),
      usedJokes: [],
      history: [],
      chatProfile: { users: {} },
      config: {
        interval: CFG.defaultInterval,
        threshold: CFG.defaultThreshold,
        sources: { jokes: true, bash: true, gen: true },
      },
    };
  }
  return state.chats[id];
}

const state = loadState();
function flushState() { writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }

// ─── Jokes RAG ────────────────────────────────────────────
function loadJokes() {
  const path = resolve(ROOT, JOKES_FILE);
  if (!existsSync(path)) return [];
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return [];
  }
}

function searchJokes(contextText, limit = 5) {
  const jokes = loadJokes();
  const words = contextText.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  const scored = jokes.map(j => {
    const txt = (j.text || '').toLowerCase();
    const tags = (j.tags || []).join(' ').toLowerCase();
    const haystack = txt + ' ' + tags;
    const score = words.filter(w => haystack.includes(w)).length;
    return { ...j, score };
  });
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

// ─── LLM ──────────────────────────────────────────────────
const openai = new OpenAI({ baseURL: LLM_BASE_URL, apiKey: LLM_API_KEY || process.env.OPENAI_API_KEY });

function buildSystemPrompt(cs, userName) {
  const profile = cs.chatProfile;
  const hint = profile.style ? `\nChat personality: ${profile.style}` : '';
  const nameHint = userName ? `\nIf the joke has a character (Вовочка, мужик, программист etc.), replace it with the user's name "${userName}" when it fits naturally.` : '';
  return `You are a joker bot in a Telegram chat. Your job is to pick or adapt jokes that fit the conversation.
Rules:
1. Be funny, absurd, or clever depending on the room.
2. Avoid offensive, political, or extremely dark humor.
3. Keep it short — one to three sentences max per joke.
4. If a joke bombs, adjust tone for next round.${hint}${nameHint}`;
}

async function assessJokes(jokes, context) {
  const prompt = `Evaluate these jokes against recent chat context. For each, score 0-10 (10 = hilarious and fitting, 0 = not funny). Be critical. Return ONLY valid JSON array: [{ "index": 0, "score": 7, "reason": "..." }]\n\nContext:\n${context}\n\nJokes:\n${jokes.map((j, i) => `[${i}] ${sanitize(j.text)}`).join('\n')}`;
  const res = await openai.chat.completions.create({
    model: LLM_MODEL,
    messages: [
      { role: 'system', content: 'You are a strict comedy judge. Return ONLY valid JSON.' },
      { role: 'user', content: prompt },
    ],
    temperature: 0.3,
  });
  if (res?.usage?.total_tokens && _cs) _cs.tokensSpent = (_cs.tokensSpent || 0) + res.usage.total_tokens;
  try {
    return JSON.parse(res.choices[0].message.content);
  } catch {
    return jokes.map((_, i) => ({ index: i, score: 0 }));
  }
}

async function generateJokesFromContext(context, count, cs, userName) {
  const prompt = `Generate ${count} short jokes that fit the following chat context. Return ONLY valid JSON array: [{ "text": "..." }]\n\nContext:\n${context}`;
  const res = await openai.chat.completions.create({
    model: LLM_MODEL,
    messages: [
      { role: 'system', content: buildSystemPrompt(cs, userName) },
      { role: 'user', content: prompt },
    ],
    temperature: 0.8,
  });
  if (res?.usage?.total_tokens && _cs) _cs.tokensSpent = (_cs.tokensSpent || 0) + res.usage.total_tokens;
  try {
    return JSON.parse(res.choices[0].message.content);
  } catch {
    return [];
  }
}

async function generateJokeFromRag(ragJoke, context, cs, userName) {
  const prompt = `Adapt the following base joke to fit the chat context. Keep the spirit. Return ONLY JSON: { "text": "..." }\n\nContext:\n${context}\n\nBase joke:\n${sanitize(ragJoke.text)}`;
  const res = await openai.chat.completions.create({
    model: LLM_MODEL,
    messages: [
      { role: 'system', content: buildSystemPrompt(cs, userName) },
      { role: 'user', content: prompt },
    ],
    temperature: 0.7,
  });
  if (res?.usage?.total_tokens && _cs) _cs.tokensSpent = (_cs.tokensSpent || 0) + res.usage.total_tokens;
  try {
    return JSON.parse(res.choices[0].message.content);
  } catch {
    return { text: ragJoke.text };
  }
}

// ─── Core logic ───────────────────────────────────────────
function sanitize(text) {
  return (text || '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')     // strip control chars
    .replace(/"""/g, '\'\'\'')                                 // prevent triple-quote breakouts
    .replace(/\b(system|assistant|user|ignore|remember|instruction|prompt|role|jailbreak|skip|override)\b/gi, m => `[${m}]`)  // neuter meta words
    .slice(0, 500);                                              // hard cap length
}

function sanitizeAll(...strings) {
  return strings.map(s => sanitize(s));
}

function getContext(cs) {
  return cs.history.slice(-10).map(m => {
    const [name, text] = sanitizeAll(m.from || 'User', m.text);
    return `${name}: ${text}`;
  }).join('\n');
}

function jokeHash(text) {
  // First 80 chars plus normalized (lowercase, no punctuation) version
  const raw = (text || '').slice(0, 80);
  const norm = (text || '').toLowerCase().replace(/[^\w\s]/g, '').trim().slice(0, 80);
  return require('crypto').createHash('md5').update(raw + '|' + norm).digest('hex').slice(0, 16);
}

function isJokeUsed(chatId, text) {
  const hash = jokeHash(text);
  const row = sdbStmts.hasHash.get(String(chatId), hash);
  return !!row;
}

function markJokeUsed(chatId, text) {
  sdbStmts.addHash.run(String(chatId), jokeHash(text));
}

// Global refs for tracking tokens and chat ID across LLM calls
let _cs = null;
let _csChatId = null;

async function pickBestJoke(chatId, cs, userName) {
  _cs = cs;
  _csChatId = chatId;
  const context = getContext(cs);
  const src = cs.config.sources || { jokes: true, bash: true, gen: true };

  // Try RAG first (jokes + bash)
  let candidates = [];
  if (src.jokes || src.bash) {
    const ragResults = searchJokes(context, 3);
    for (const rj of ragResults) {
      if (rj.score > 0) {
        const rjSource = rj.tags?.includes('bash') ? 'bash' : 'joke';
        if ((rjSource === 'bash' && !src.bash) || (rjSource === 'joke' && !src.jokes)) continue;
        const adapted = await generateJokeFromRag(rj, context, cs, userName);
        adapted.source = rjSource;
        candidates.push(adapted);
      }
    }
  }

  // Try RAG first
  if (candidates.length > 0) {
    const dedupSet = new Set(cs.usedJokes.slice(-CFG.dedup));
    const chatIdStr = String(_csChatId);
    const unique = candidates.filter(j => {
      const dedupKey = j.text?.slice(0, 80);
      if (dedupSet.has(dedupKey)) return false;
      if (isJokeUsed(chatIdStr, dedupKey)) return false;
      return true;
    });
    if (unique.length > 0) {
      const scores = await assessJokes(unique, context);
      const best = scores.reduce((a, b) => (b.score > a.score ? b : a), scores[0]);
      if (best.score >= cs.config.threshold) {
        const joke = unique[best.index];
        const dedupKey = joke.text?.slice(0, 80);
        cs.usedJokes.push(dedupKey);
        if (cs.usedJokes.length > CFG.dedup * 2) {
          cs.usedJokes = cs.usedJokes.slice(-CFG.dedup);
        }
        markJokeUsed(chatIdStr, dedupKey);
        return { joke, score: best.score, reason: best.reason, source: joke.source || 'gen' };
      }
    }
  }

  // Fallback: generate fresh jokes via LLM
  if (!src.gen) return null;
  candidates = await generateJokesFromContext(context, 3, cs, userName);

  if (candidates.length === 0) return null;

  const chatIdStr = String(_csChatId);
  const dedupSet = new Set(cs.usedJokes.slice(-CFG.dedup));
  const unique = candidates.filter(j => {
    const dedupKey = j.text?.slice(0, 80);
    if (dedupSet.has(dedupKey)) return false;
    if (isJokeUsed(chatIdStr, dedupKey)) return false;
    return true;
  });
  if (unique.length === 0) return null;

  const scores = await assessJokes(unique, context);
  const best = scores.reduce((a, b) => (b.score > a.score ? b : a), scores[0]);

  if (best.score >= cs.config.threshold) {
    const joke = unique[best.index];
    const dedupKey = joke.text?.slice(0, 80);
    cs.usedJokes.push(dedupKey);
    if (cs.usedJokes.length > CFG.dedup * 2) {
      cs.usedJokes = cs.usedJokes.slice(-CFG.dedup);
    }
    markJokeUsed(chatIdStr, dedupKey);
    return { joke, score: best.score, reason: best.reason, source: joke.source || 'gen' };
  }
  return null;
}

async function tryTellJoke(chatId, cs, userName, replyToMsgId) {
  try {
    info('tryTellJoke: chat', chatId, 'user', userName, 'replyTo', replyToMsgId);
    const result = await pickBestJoke(chatId, cs, userName);
    if (result) {
      info('tryTellJoke: got result score', result.score, 'source', result.source);
      const tagMap = { bash: '💻', joke: '📖', gen: '🤖' };
      const tag = tagMap[result.source] || '';
      const text = `${result.joke.text} ${tag}`;
      await bot.sendMessage(chatId, text, replyToMsgId ? { reply_to_message_id: replyToMsgId } : {});

      if (result.score >= 9) cs.chatProfile.style = 'absurd';
      else if (result.score >= 7) cs.chatProfile.style = 'clever';
      else cs.chatProfile.style = 'light';

      cs.jokesToday = (cs.jokesToday || 0) + 1;

      const chatIdStr = String(chatId);
      sdbStmts.addTopJoke.run(chatIdStr, result.joke.text, result.score, result.source || '', Date.now());

      if (cs.history.length > 0) {
        const last = cs.history[cs.history.length - 1];
        const lastUser = last && (last.fromUserKey || last.from);
        const userData = lastUser && cs.chatProfile.users[lastUser];
        if (userData) {
          userData.jokes = (userData.jokes || 0) + 1;
          sdbStmts.upsertUser.run(chatIdStr, lastUser, userData.jokes, userData.messages || 0);
        }
      }
      flushState();
    } else {
      info('tryTellJoke: no result, stepping back');
      cs.messageCount--;
      flushState();
    }
  } catch (e) {
    error('tryTellJoke ERROR:', e.message, e.stack);
  }
}

function estimateTokens(text) {
  return Math.ceil((text || '').length / 2);
}

// ─── Allowed admins (only these users can use /j commands)
const ADMIN_USERNAMES = new Set(
  (process.env.ADMIN_USERNAMES || 'MikhailAngelov').split(',').map(s => s.trim().toLowerCase())
);

function isAdmin(msg) {
  const username = msg.from?.username?.toLowerCase();
  return username && ADMIN_USERNAMES.has(username);
}

// ─── Commands ─────────────────────────────────────────────
function handleCommand(msg) {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  const cs = getChatState(chatId);

  if (!isAdmin(msg)) {
    return true;
  }

  if (text === '/config' || text === '/jconfig') {
    const c = cs.config;
    const srcLabels = { jokes: '📖', bash: '💻', gen: '🤖' };
    const sources = Object.entries(c.sources).map(([k, v]) => `${srcLabels[k] || k}: ${v ? '✅' : '❌'}`).join(', ');
    bot.sendMessage(chatId,
      `📋 Настройки чата:\n• Интервал: ${c.interval} сообщ.\n• Порог: ${c.threshold}/10\n• Источники: ${sources}\n• Дедуп: ${CFG.dedup} шт.\n\nИзменить: /jinterval N, /jthreshold N, /jsource a|b|l on|off`
    );
    return true;
  }

  const sourceMatch = text.match(/^\/source\s+([abl])\s+(on|off)$/) || text.match(/^\/jsource\s+([abl])\s+(on|off)$/);
  if (sourceMatch) {
    const keyMap = { a: 'jokes', b: 'bash', l: 'gen' };
    const key = keyMap[sourceMatch[1]];
    const val = sourceMatch[2] === 'on';
    cs.config.sources[key] = val;
    flushState();
    const labelMap = { a: '📖 Анекдоты', b: '💻 Башорг', l: '🤖 LLM' };
    bot.sendMessage(chatId, `✅ ${labelMap[sourceMatch[1]]}: ${val ? 'включён' : 'выключен'}`);
    return true;
  }

  if (text === '/stats' || text === '/jstats' || text === '/top' || text === '/jtop') {
    const chatIdStr = String(chatId);
    const users = sdbStmts.getUserStats.all(chatIdStr);
    const topJokes = sdbStmts.getTopJokes.all(chatIdStr, 3);
    const tagMap = { bash: '💻', joke: '📖', gen: '🤖' };

    let msg = `📊 Статистика чата\n`;
    msg += `Шуток сегодня: ${cs.jokesToday || 0}\n`;
    msg += `Всего сообщений: ${cs.messageCount}\n`;
    msg += `Токенов потрачено: ~${cs.tokensSpent || 0}\n\n`;

    if (users.length > 0) {
      msg += `👤 Топ насмешников:\n`;
      msg += users.slice(0, 5).map((r, i) =>
        `${i + 1}. ${r.username} — ${r.jokes} шуток / ${r.messages} сообщ.`
      ).join('\n');
      msg += '\n\n';
    }

    if (topJokes.length > 0) {
      msg += `🏆 Топ шуток:\n`;
      msg += topJokes.map((r, i) =>
        `${i + 1}. ${r.joke_text.slice(0, 150)} (${r.score}/10) ${tagMap[r.source] || ''}`
      ).join('\n');
    }

    bot.sendMessage(chatId, msg);
    return true;
  }

  const intervalMatch = text.match(/^\/interval\s+(\d+)$/) || text.match(/^\/jinterval\s+(\d+)$/);
  if (intervalMatch) {
    const val = parseInt(intervalMatch[1], 10);
    if (val < 1) { bot.sendMessage(chatId, '❌ Минимум 1'); return true; }
    cs.config.interval = val;
    cs.messageCount = 0;
    flushState();
    bot.sendMessage(chatId, `✅ Интервал изменён: каждые ${val} сообщений`);
    return true;
  }

  const thresholdMatch = text.match(/^\/threshold\s+(\d+)$/) || text.match(/^\/jthreshold\s+(\d+)$/);
  if (thresholdMatch) {
    const val = parseInt(thresholdMatch[1], 10);
    if (val < 1 || val > 10) { bot.sendMessage(chatId, '❌ От 1 до 10'); return true; }
    cs.config.threshold = val;
    flushState();
    bot.sendMessage(chatId, `✅ Порог изменён: ${val}/10`);
    return true;
  }

  if (text.startsWith('/j') || text.startsWith('/')) {
    bot.sendMessage(chatId, 'Команды:\n/config — настройки чата\n/interval N — интервал (сообщ.)\n/threshold N — порог качества (1-10)\n/source a|b|l on|off — источники (анекдот/башорг/LLM)\n/stats — статистика и топ шуток');
    return true;
  }

  return false;
}

// ─── Message handler ──────────────────────────────────────
async function onMessage(msg) {
  const chatId = msg.chat.id;
  const text = msg.text || msg.caption || '';
  if (!text) return;

  if (text.startsWith('/config') || text.startsWith('/interval') || text.startsWith('/threshold') || text.startsWith('/source') || text.startsWith('/stats') || text.startsWith('/top') || text.startsWith('/jconfig') || text.startsWith('/jinterval') || text.startsWith('/jthreshold') || text.startsWith('/jsource') || text.startsWith('/jstats') || text.startsWith('/jtop')) {
    handleCommand(msg);
    return;
  }

  const chatTitle = msg.chat.title || msg.chat.username || (msg.chat.first_name || '') + ' ' + (msg.chat.last_name || '') || 'private';
  const chatFromName = msg.from?.first_name || msg.from?.username || 'unknown';
  const chatFromUser = msg.from?.username ? `@${msg.from.username}` : chatFromName;
  info(`[${chatTitle}] <${chatFromUser}> ${text.slice(0, 120)}`);

  const cs = getChatState(chatId);

  const userName = msg.from?.first_name || msg.from?.username || 'User';
  const userKey = msg.from?.username || msg.from?.first_name || 'unknown';
  const botInfo = bot._botInfo || { username: 'jocker_oc_bot' };
  const botUsername = botInfo.username?.toLowerCase();
  const isMention = text.toLowerCase().includes('@' + botUsername);
  const replyTo = msg.reply_to_message;
  const isReplyToBot = replyTo && replyTo.from?.is_bot;


  cs.history.push({
    from: msg.from?.first_name || msg.from?.username || 'Unknown',
    fromUserKey: userKey,
    text,
    ts: Date.now(),
  });
  if (cs.history.length > 100) cs.history = cs.history.slice(-100);

  // Reset daily counters if new day
  const today = new Date().toDateString();
  if (cs.lastDay !== today) {
    cs.jokesToday = 0;
    cs.lastDay = today;
  }

  cs.messageCount++;

  if (!cs.chatProfile.users[userKey]) cs.chatProfile.users[userKey] = { messages: 0, jokes: 0 };
  cs.chatProfile.users[userKey].messages++;

  // Sync user stats to SQLite
  const chatIdStr = String(chatId);
  sdbStmts.upsertUser.run(chatIdStr, userKey, cs.chatProfile.users[userKey].jokes, cs.chatProfile.users[userKey].messages);

  // Reply to the message that triggered the joke
  const replyToMsgId = isMention || isReplyToBot ? msg.message_id : null;

  if (isMention || isReplyToBot) {
    info(`TRIGGER: mention/reply [${chatTitle}]`);
    tryTellJoke(chatId, cs, userName, replyToMsgId).catch(e => error('joke error:', e.message));
  }

  if (cs.messageCount % cs.config.interval === 0) {
    info(`TRIGGER: interval [${chatTitle}]`);
    tryTellJoke(chatId, cs, userName, null).catch(e => error('joke error:', e.message));
  }

  flushState();
}

// ─── Init ─────────────────────────────────────────────────
if (!BOT_TOKEN) {
  error('❌ BOT_TOKEN is required.');
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
bot.on('message', onMessage);

info(`Jocker Bot started. Interval: ${CFG.defaultInterval}, threshold: ${CFG.defaultThreshold}`);

// Clean old hashes on startup + every hour
sdbStmts.cleanHashes.run();
setInterval(() => {
  try {
    sdbStmts.cleanHashes.run();
  } catch (e) {
    error('hash cleanup:', e.message);
  }
}, 3600000);

// ─── Observability ────────────────────────────────────────
function log(level, msg) {
  const ts = new Date().toISOString();
  const line = `${ts} ${level.padEnd(5)} ${msg}`;
  if (level === 'ERROR') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

function info(...args) { log('INFO', args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ')); }
function warn(...args) { log('WARN', args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ')); }
function error(...args) { log('ERROR', args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ')); }

process.on('unhandledRejection', (err) => {
  error(`UNHANDLED REJECTION: ${err.message}`, err.stack);
});
process.on('uncaughtException', (err) => {
  error(`UNCAUGHT EXCEPTION: ${err.message}`, err.stack);
  process.exit(1);
});

// Replace raw console calls with structured logging
const origLog = console.log;
const origError = console.error;
