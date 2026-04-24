/**
 * joker-core.js — pure functions for jocker-bot.
 * No Telegram, OpenAI, or filesystem dependencies.
 */
import { createHash } from 'crypto';

// ═══════════════════════════════════════════════════════════
// Sanitize
// ═══════════════════════════════════════════════════════════

export function sanitize(text) {
  return (text || '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .replace(/"""/g, "'''")
    .replace(/\b(system|assistant|user|ignore|remember|instruction|prompt|role|jailbreak|skip|override)\b/gi, m => `[${m}]`)
    .slice(0, 500);
}

export function sanitizeAll(...strings) {
  return strings.map(s => sanitize(s));
}

// ═══════════════════════════════════════════════════════════
// Context
// ═══════════════════════════════════════════════════════════

export function getContext(history) {
  return history.slice(-10).map(m => {
    const [name, text] = sanitizeAll(m.from || 'User', m.text);
    return `${name}: ${text}`;
  }).join('\n');
}

// ═══════════════════════════════════════════════════════════
// Dedup
// ═══════════════════════════════════════════════════════════

export function jokeHash(text) {
  const raw = (text || '').slice(0, 80);
  const norm = (text || '').toLowerCase().replace(/[^\w\s]/g, '').trim().slice(0, 80);
  return createHash('md5').update(raw + '|' + norm).digest('hex').slice(0, 16);
}

export function dedupKey(text) {
  return (text || '').slice(0, 80);
}

export function filterCandidates(candidates, usedSet, hashDb) {
  return candidates.filter(j => {
    const key = dedupKey(j.text);
    if (!key) return false;
    if (usedSet?.has(key)) return false;
    if (hashDb?.has(key)) return false;
    return true;
  });
}

export function markUsed(cs, hashDb, text, dedupSize) {
  const key = dedupKey(text);
  cs.usedJokes.push(key);
  if (cs.usedJokes.length > dedupSize * 2) {
    cs.usedJokes = cs.usedJokes.slice(-dedupSize);
  }
  hashDb?.add(key);
  return key;
}

// ═══════════════════════════════════════════════════════════
// Search (RAG)
// ═══════════════════════════════════════════════════════════

export function searchJokes(jokes, contextText, limit = 5) {
  if (!jokes?.length) return [];
  const words = (contextText || '')
    .toLowerCase()
    .split(/\s+/)
    .filter(w => w.length > 2);
  if (!words.length) return jokes.slice(0, limit).map(j => ({ ...j, score: 1 }));

  return jokes
    .map(j => {
      const haystack = ((j.text || '') + ' ' + (j.tags || []).join(' ')).toLowerCase();
      return { ...j, score: words.filter(w => haystack.includes(w)).length };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// ═══════════════════════════════════════════════════════════
// Scoring
// ═══════════════════════════════════════════════════════════

export function estimateTokens(text) {
  return Math.ceil((text || '').length / 2);
}

export function pickBest(scores, candidates, threshold) {
  const best = scores.reduce((a, b) => (b.score > a.score ? b : a), scores[0]);
  if (best.score < threshold) return null;
  const joke = candidates[best.index];
  if (!joke) return null;
  return { joke, score: best.score, reason: best.reason, source: joke.source || 'gen' };
}

// ═══════════════════════════════════════════════════════════
// Config / State
// ═══════════════════════════════════════════════════════════

export function createDefaultConfig(interval = 100, threshold = 7) {
  return { interval, threshold, sources: { jokes: true, bash: true, gen: true } };
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
    chatProfile: { style: 'light', users: {} },
  };
}

// ═══════════════════════════════════════════════════════════
// System Prompt
// ═══════════════════════════════════════════════════════════

export function buildSystemPrompt(style, userName) {
  const hints = [];
  if (style) hints.push(`Chat personality: ${style}`);
  if (userName) hints.push(
    `If the joke has a character (Вовочка, мужик, программист etc.), replace it with the user's name "${userName}" when it fits naturally.`
  );
  const hintBlock = hints.length ? '\n\n' + hints.join('\n') : '';
  return `You are a joker bot in a Telegram chat. Your job is to pick or adapt jokes that fit the conversation.
Rules:
1. Be funny, absurd, or clever depending on the room.
2. Avoid offensive, political, or extremely dark humor.
3. Keep it short — one to three sentences max per joke.
4. If a joke bombs, adjust tone for next round.${hintBlock}`;
}
