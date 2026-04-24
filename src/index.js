import dotenv from 'dotenv';
import TelegramBot from 'node-telegram-bot-api';
import OpenAI from 'openai';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// ─── Config ────────────────────────────────────────────────
const {
  BOT_TOKEN,
  CHAT_ID,
  LLM_API_KEY,
  LLM_BASE_URL = 'https://api.deepseek.com',
  LLM_MODEL = 'deepseek-chat',
  JOKES_FILE = './data/jokes.json',
  JOKE_INTERVAL = '100',
  PROBE_WINDOW = '10',
  QUALITY_THRESHOLD = '7',
  DEDUP_WINDOW = '50',
} = process.env;

const CFG = {
  interval: parseInt(JOKE_INTERVAL, 10),
  probe: parseInt(PROBE_WINDOW, 10),
  threshold: parseInt(QUALITY_THRESHOLD, 10),
  dedup: parseInt(DEDUP_WINDOW, 10),
  chatId: CHAT_ID || null,
};

// ─── State (persisted to disk) ─────────────────────────────
const STATE_FILE = resolve(ROOT, 'data/state.json');

function loadState() {
  if (!existsSync(STATE_FILE)) return { messageCount: 0, usedJokes: [], history: [], chatProfile: {} };
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
  } catch {
    return { messageCount: 0, usedJokes: [], history: [], chatProfile: {} };
  }
}

function saveState(s) {
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

const state = loadState();

function flushState() {
  saveState(state);
}

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
const openai = new OpenAI({ baseURL: LLM_BASE_URL, apiKey: LLM_API_KEY });

function buildSystemPrompt() {
  const profile = state.chatProfile;
  const profileHint = profile.style
    ? `\nChat personality: ${profile.style}`
    : '';
  return `You are a joker bot in a Telegram chat. Your job is to pick or adapt jokes that fit the current conversation context.
Rules:
1. Be funny, absurd, or clever depending on the room.
2. Avoid offensive, political, or extremely dark humor.
3. Keep it short — one to three sentences max per joke.
4. If a joke bombs, adjust tone for next round.${profileHint}`;
}

async function assessJokes(jokes, context) {
  const prompt = `Here is the recent chat context:\n"""\n${context}\n"""\n\nEvaluate these jokes. For each, give a score 0-10 (10 = hilarious and fitting, 0 = not funny at all). Be critical. Return ONLY valid JSON array of objects: [{ "index": 0, "score": 7, "reason": "..." }]\n\nJokes:\n${jokes.map((j, i) => `[${i}] ${j.text}`).join('\n')}`;

  const res = await openai.chat.completions.create({
    model: LLM_MODEL,
    messages: [
      { role: 'system', content: 'You are a strict comedy judge. Return ONLY valid JSON.' },
      { role: 'user', content: prompt },
    ],
    temperature: 0.3,
  });

  try {
    return JSON.parse(res.choices[0].message.content);
  } catch {
    return jokes.map((_, i) => ({ index: i, score: 0 }));
  }
}

async function generateJokesFromContext(context, count = 3) {
  const prompt = `Recent chat:\n"""\n${context}\n"""\n\nGenerate ${count} short jokes that fit this chat context. Return ONLY valid JSON array: [{ "text": "..." }]`;

  const res = await openai.chat.completions.create({
    model: LLM_MODEL,
    messages: [
      { role: 'system', content: buildSystemPrompt() },
      { role: 'user', content: prompt },
    ],
    temperature: 0.8,
  });

  try {
    return JSON.parse(res.choices[0].message.content);
  } catch {
    return [];
  }
}

async function generateJokeFromRag(ragJoke, context) {
  const prompt = `Recent chat:\n"""\n${context}\n"""\n\nHere is a joke from the database:\n"""\n${ragJoke.text}\n"""\n\nAdapt it to fit the chat context. Make it natural, keep the spirit. Return ONLY JSON: { "text": "..." }`;

  const res = await openai.chat.completions.create({
    model: LLM_MODEL,
    messages: [
      { role: 'system', content: buildSystemPrompt() },
      { role: 'user', content: prompt },
    ],
    temperature: 0.7,
  });

  try {
    return JSON.parse(res.choices[0].message.content);
  } catch {
    return { text: ragJoke.text };
  }
}

// ─── Core logic ───────────────────────────────────────────
function getContext() {
  return state.history.slice(-10).map(m => `${m.from || 'User'}: ${m.text}`).join('\n');
}

async function pickBestJoke(context) {
  const candidates = [];

  // 1. Search RAG
  const ragResults = searchJokes(context, 3);
  for (const rj of ragResults) {
    if (rj.score > 0) {
      const adapted = await generateJokeFromRag(rj, context);
      candidates.push(adapted);
    }
  }

  // 2. Generate fresh
  const fresh = await generateJokesFromContext(context, 3);
  candidates.push(...fresh);

  if (candidates.length === 0) return null;

  // 3. Dedup
  const dedupSet = new Set(state.usedJokes.slice(-CFG.dedup));
  const unique = candidates.filter(j => !dedupSet.has(j.text?.slice(0, 80)));

  if (unique.length === 0) return null;

  // 4. Assess
  const scores = await assessJokes(unique, context);
  const best = scores.reduce((a, b) => (b.score > a.score ? b : a), scores[0]);

  if (best.score >= CFG.threshold) {
    const joke = unique[best.index];
    // remember
    state.usedJokes.push(joke.text?.slice(0, 80));
    if (state.usedJokes.length > CFG.dedup * 2) {
      state.usedJokes = state.usedJokes.slice(-CFG.dedup);
    }
    return { joke, score: best.score, reason: best.reason };
  }

  return null;
}

async function onMessage(msg) {
  const chatId = msg.chat.id;
  if (CFG.chatId && String(chatId) !== String(CFG.chatId)) return;

  const text = msg.text || msg.caption || '';
  if (!text) return;

  // Track history
  state.history.push({ from: msg.from?.first_name || msg.from?.username || 'Unknown', text, ts: Date.now() });
  if (state.history.length > 100) state.history = state.history.slice(-100);

  state.messageCount++;

  // Track user style
  const name = msg.from?.username || msg.from?.first_name || 'unknown';
  if (!state.chatProfile.users) state.chatProfile.users = {};
  if (!state.chatProfile.users[name]) state.chatProfile.users[name] = { messages: 0, jokes: 0 };
  state.chatProfile.users[name].messages++;

  if (state.messageCount % CFG.interval === 0) {
    await tryTellJoke(chatId);
  }

  flushState();
}

async function tryTellJoke(chatId, retries = CFG.probe) {
  const context = getContext();
  const result = await pickBestJoke(context);

  if (result) {
    await bot.sendMessage(chatId, `${result.joke.text}`);

    // Track style shift based on score
    const styleScore = result.score;
    if (styleScore >= 9) state.chatProfile.style = 'absurd';
    else if (styleScore >= 7) state.chatProfile.style = 'clever';
    else state.chatProfile.style = 'light';

    // Track who triggered it
    if (state.history.length > 0) {
      const last = state.history[state.history.length - 1];
      if (last && state.chatProfile.users[last.from]) {
        state.chatProfile.users[last.from].jokes++;
      }
    }

    flushState();
  } else if (retries > 0) {
    // Wait for more messages and retry
    state.messageCount--; // step back so next message triggers again
    flushState();
  }
}

// ─── Reaction tracking ────────────────────────────────────
async function onReaction(msg) {
  // Track reply thread to a joke message
  if (!msg.reply_to_message) return;
  const chatId = msg.chat.id;

  // If our joke was replied to — count as reaction
  state.chatProfile.lastReaction = Date.now();
  flushState();
}

// ─── Init ─────────────────────────────────────────────────
if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN is required. Set it in .env or environment.');
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

bot.on('message', onMessage);
bot.on('callback_query', onReaction);

console.log(`🤖 Jocker Bot started. Interval: every ${CFG.interval} msgs, probe: ${CFG.probe}, threshold: ${CFG.threshold}`);
