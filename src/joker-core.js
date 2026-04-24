/**
 * joker-core.js — pure functions extracted from index.js for testing.
 * No Telegram, OpenAI, or filesystem dependencies.
 */
import { createHash } from 'crypto';

// ─── Sanitize ──────────────────────────────────────────────

export function sanitize(text) {
  return (text || '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')     // strip control chars
    .replace(/"""/g, "'''")                                // prevent triple-quote breakouts
    .replace(/\b(system|assistant|user|ignore|remember|instruction|prompt|role|jailbreak|skip|override)\b/gi, m => `[${m}]`)  // neuter meta words
    .slice(0, 500);                                        // hard cap length
}

export function sanitizeAll(...strings) {
  return strings.map(s => sanitize(s));
}

// ─── Context ───────────────────────────────────────────────

export function getContext(history) {
  return history.slice(-10).map(m => {
    const name = sanitize(m.from || 'User');
    const text = sanitize(m.text || '');
    return `${name}: ${text}`;
  }).join('\n');
}

// ─── Dedup ─────────────────────────────────────────────────

export function jokeHash(text) {
  const raw = (text || '').slice(0, 80);
  const norm = (text || '').toLowerCase().replace(/[^\w\s]/g, '').trim().slice(0, 80);
  return createHash('md5').update(raw + '|' + norm).digest('hex').slice(0, 16);
}

export function isDuplicate(usedSet, hashDb, text) {
  const key = (text || '').slice(0, 80);
  if (usedSet && usedSet.has(key)) return true;
  if (hashDb && hashDb.has(jokeHash(text))) return true;
  return false;
}

export function filterUnique(candidates, usedSet, hashDb) {
  return candidates.filter(j => {
    const key = j.text?.slice(0, 80);
    if (!key) return false;
    if (usedSet && usedSet.has(key)) return false;
    if (hashDb && hashDb.has(jokeHash(key))) return false;
    return true;
  });
}

// ─── Scoring ───────────────────────────────────────────────

export function estimateTokens(text) {
  return Math.ceil((text || '').length / 2);
}

// ─── Search (RAG) ──────────────────────────────────────────

export function searchJokes(jokes, contextText, limit = 5) {
  if (!jokes || !jokes.length) return [];

  // Simple keyword matching
  const keywords = (contextText || '')
    .toLowerCase()
    .replace(/[^\w\sёа-яa-z]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 3);

  if (keywords.length === 0) return jokes.slice(0, limit).map(j => ({ ...j, score: 1 }));

  const scored = jokes.map(joke => {
    const text = ((joke.text || '') + ' ' + (joke.tags || []).join(' ')).toLowerCase();
    let score = 0;
    for (const kw of keywords) {
      if (text.includes(kw)) score += 1;
    }
    // Bonus for short jokes
    if (text.length < 100) score += 0.5;
    // Normalize
    return { ...joke, score: score / Math.max(keywords.length, 1) };
  });

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// ─── State ─────────────────────────────────────────────────

export function createDefaultConfig(interval = 100, threshold = 7) {
  return {
    interval,
    threshold,
    sources: { jokes: true, bash: true, gen: true },
  };
}

export function createChatState(chatId, interval, threshold) {
  return {
    chatId,
    config: createDefaultConfig(interval, threshold),
    messageCount: 0,
    jokesToday: 0,
    tokensSpent: 0,
    lastDay: new Date().toDateString(),
    usedJokes: [],
    history: [],
    chatProfile: {
      style: 'light',
      users: {},
    },
  };
}

// ─── System Prompt Builder ─────────────────────────────────

export function buildSystemPrompt(style, userName) {
  const styleHint = style ? `\nChat personality: ${style}` : '';
  const nameHint = userName
    ? `\nIf the joke has a character (Вовочка, мужик, программист etc.), replace it with the user's name "${userName}" when it fits naturally.`
    : '';
  return `You are a comedian in a Telegram group chat. Your role:
1. Always respond in Russian.
2. Keep jokes short (1-3 sentences).
3. Match the chat's vibe — observe recent messages for tone.
4. If a joke bombs, adjust tone for next round.${styleHint}${nameHint}`;
}
