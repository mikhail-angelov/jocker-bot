# PRD: Jocker Bot (@JockerOCCBot)

> Product Requirements Document  
> Версия: 1.0  
> Дата: 2026-04-24

---

## 1. Overview

Telegram-бот-джокер для русскоязычных групповых чатов. Шутит через заданный интервал сообщений, по упоминанию и при ответе на его сообщения. Использует RAG по базе анекдотов (anekdot.me) и цитат (bash.org.ru), а также LLM-генерацию (DeepSeek) для адаптации и создания новых шуток.

## 2. Goals

- Развлекать участников чата релевантными шутками
- Минимизировать повторения (дедупликация in-memory + SQLite)
- Персонализировать шутки (подстановка имени пользователя)
- Давать админу контроль над частотой, качеством и источниками
- Собирать статистику для аналитики

## 3. Architecture

### 3.1 High-level

```
Telegram Chat  ←→  Telegram Bot (node-telegram-bot-api, polling)
                          │
                    ┌─────┴──────┐
                    │  index.js  │  ← оркестрация, Telegram, SQLite, LLM
                    └─────┬──────┘
                          │ импорт
                    ┌─────┴──────┐
                    │joker-core  │  ← чистые функции (sanitize, dedup, RAG, конфиги)
                    └────────────┘
                          │
          ┌───────────────┼───────────────┐
          │               │               │
     data/           data/           data/
   jokes.json     state.json      stats.db
   (10426 шт.)   (per-chat JSON)  (SQLite)
```

### 3.2 Components

**index.js** — основной файл бота (Telegram polling, SQLite, OpenAI/DeepSeek вызовы, команды)

**joker-core.js** — модуль чистых функций без внешних зависимостей:
- `sanitize()` / `sanitizeAll()` — prompt injection protection
- `getContext()` — форматирование истории чата для LLM
- `jokeHash()` / `dedupKey()` / `filterCandidates()` / `markUsed()` — дедупликация
- `searchJokes()` — RAG по ключевым словам (без эмбеддингов)
- `pickBest()` — выбор лучшей шутки по оценкам
- `buildSystemPrompt()` — генерация системного промпта

### 3.3 Storage

| Файл | Формат | Назначение |
|------|--------|------------|
| `data/jokes.json` | JSON | База шуток (`[{text, tags}]`, 10426 записей) |
| `data/state.json` | JSON | Per-chat конфиги, история, usedJokes |
| `data/stats.db` | SQLite | Статистика (top_jokes, user_stats, joke_hashes) |

### 3.4 Joke Pipeline

```
Message received
    │
    ├── Command? → handleCommand() (config, stats, interval, threshold, source)
    │
    └── Regular message →
         ├── Update history + counters
         ├── If mention/reply → tryTellJoke() immediately
         └── If interval hit → tryTellJoke()
              │
              └── pickBestJoke()
                   │
                   ├── 1. RAG: searchJokes() → adaptJoke() (LLM adapts base joke)
                   │       ↓
                   │      filterCandidates() → assessJokes() (LLM scores)
                   │       ↓
                   │      pickBest() ≥ threshold? → ✅ return
                   │
                   └── 2. Fallback: generateJokes() (LLM generates fresh)
                           ↓
                          filterCandidates() → assessJokes()
                           ↓
                          pickBest() ≥ threshold? → ✅ return / ❌ skip
```

## 4. Features

### 4.1 Triggers
- **Interval**: каждые N сообщений в чате (настраивается, по умолчанию 100)
- **Mention**: @JockerOCCBot в сообщении
- **Reply**: ответ на сообщение бота
- Все шутки отправляются как reply на сообщение-триггер

### 4.2 Source icons
- 📖 — анекдот из базы
- 💻 — bash.org.ru
- 🤖 — LLM-генерация

### 4.3 Priority
RAG (адаптация из базы) > LLM-генерация. Если RAG candidates не прошли порог — генерируем свежие.

### 4.4 Deduplication
- In-memory: `usedJokes[]` (100 шт. в `data/state.json`)
- SQLite: `joke_hashes` (MD5 от первых 80 символов + нормализованная версия, auto-clean 7 дней)
- RAG candidates фильтруются перед адаптацией

### 4.5 Admin commands (только MikhailAngelov)

| Команда | Описание |
|---------|----------|
| `/config` | Текущие настройки чата |
| `/interval N` | Интервал в сообщениях (≥1) |
| `/threshold N` | Порог качества (1-10) |
| `/source [a\|b\|l] on\|off` | Вкл/выкл источник (a=anekdot, b=bash, l=llm) |
| `/stats` | Статистика чата |

### 4.6 Stats (SQLite)

**top_jokes**: chat_id, joke_text, score, source, ts  
**user_stats**: chat_id, username, jokes_given, messages_sent  
**joke_hashes**: chat_id, hash, created_at  

Вывод `/stats`: шуток сегодня, всего сообщений, токенов потрачено, топ-5 насмешников, топ-3 шуток.

## 5. Technical Design

### 5.1 Stack
- **Runtime**: Node.js 24 (ESM)
- **Framework**: node-telegram-bot-api
- **LLM**: OpenAI SDK → DeepSeek API (deepseek-chat)
- **Database**: better-sqlite3 (stats.db)
- **Config**: JSON file (state.json)
- **Testing**: node:test (native)

### 5.2 Prompt injection protection (`sanitize()`)
- Удаление control characters
- Замена тройных кавычек
- Нейтрализация: system, assistant, user, ignore, remember, instruction, prompt, role, jailbreak, skip, override → `[word]`
- Обрезание до 500 символов

### 5.3 Error handling
- Структурированные логи: ISO timestamp + уровень + `[чат] @username`
- Ошибки в stderr
- `unhandledRejection` + `uncaughtException`

### 5.4 Config (`openclaw.json` → jocker-bot)
- `.env` (BOT_TOKEN, LLM_API_KEY, ADMIN_USERNAMES, LLM_BASE_URL, LLM_MODEL)
- `data/state.json` — per-chat конфиги
- `data/stats.db` — SQLite статистика

## 6. Infrastructure

### 6.1 Deployment
- Docker (Alpine, multi-stage, non-root)
- docker-compose.yml (volume mount для data/)
- ghcr.io registry
- GitHub Actions (CI + Release)

### 6.2 Files

```
jocker-bot/
├── src/
│   ├── index.js          ← основной код
│   └── joker-core.js     ← чистые функции
├── data/
│   ├── jokes.json        ← база шуток (10426)
│   ├── state.json        ← per-chat конфиги
│   ├── stats.db          ← SQLite статистика
│   └── jokes.example.json
├── tests/
│   └── joker-core.test.js ← 24 теста
├── Dockerfile
├── docker-compose.yml
├── Makefile
├── package.json
└── .github/workflows/
    ├── ci.yml
    └── release.yml
```

## 7. Future (v2 ideas)
- Voice jokes (TTS)
- Жанровые фильтры (программистские, жизненные, etc.)
- Эмбеддинги для semantic RAG (сейчас только keyword match)
- Interactive «rate this joke» кнопки
- Multi-LLM поддержка

## 8. Contact
- **GitHub**: https://github.com/mikhail-angelov/jocker-bot
- **Bot**: @JockerOCCBot
- **Admin**: @MikhailAngelov
