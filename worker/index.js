// Cloudflare Worker: порт netlify/functions на Workers (статика — из ./dist через assets).
//
// GET  /api/reports  → 14 seed-отчётов из src/seedData.js (как автосев reports.mjs).
// POST /api/reports  → та же санитизация и id, что в reports.mjs, но БЕЗ хранилища:
//                      Netlify Blobs на Cloudflare нет, поэтому отчёт возвращается клиенту
//                      (портал добавляет его оптимистично) и не переживает перезагрузку.
// POST /api/extract  → живой AI-разбор. Работает, только если задан секрет ANTHROPIC_API_KEY
//                      (`npx wrangler secret put ANTHROPIC_API_KEY`), иначе 503.
//                      Демо-путь «Заполнить демо-данными» обходится без него (локально в SubmitFlow).
// Отзыв (Netlify Forms, POST /) на Cloudflare не принимается: assets отвечают 405, модалка это показывает.

import { seedReports } from '../src/seedData.js'
import extract from '../netlify/functions/extract.mjs'

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store, max-age=0' },
})

// ---- ниже без изменений из netlify/functions/reports.mjs ----
const AREAS = ['Economic Development', 'Health', 'Education & STEM', 'Environment', 'Disaster Preparedness', 'Community Support']
const CITIES = ['Atyrau', 'Aktau', 'Aktobe', 'Astana', 'Almaty', 'Nationwide']
const SEVERITIES = ['low', 'medium', 'high']

// Портал публичный и self-serve (логина нет намеренно), поэтому POST должен быть БЕЗВРЕДЕН
// при любом входе: вырезаем HTML-теги из всех строк (защита от stored-XSS в reportMarkdown),
// приводим типы, режем длины. Даже сырой curl не сможет ни сломать рендер, ни внедрить скрипт.
// Убираем только настоящие HTML-теги (<tag ...> / </tag>), НЕ трогая одиночный «<» в тексте.
const TAG_RE = /<\/?[a-zA-Z][^>]*>/g
const SCRIPTY_RE = /<\s*(script|style|iframe|object|embed)[\s\S]*?<\s*\/\s*\1\s*>/gi
const stripTags = (s) => String(s ?? '').replace(SCRIPTY_RE, '').replace(TAG_RE, '')
const clean = (s, max) => stripTags(s).slice(0, max).trim()
const cleanMarkdown = (s) => String(s ?? '')
  .replace(/<\s*(script|iframe|object|embed|style|link|meta)[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
  .replace(TAG_RE, '')               // HTML-теги; markdown-синтаксис (#, |, *, > ) не трогается
  .replace(/javascript:/gi, '')
  .slice(0, 50000)
const cleanInt = (n) => (Number.isInteger(n) && n >= 0 && n <= 100000000 ? n : null)
const cleanArr = (a) => (Array.isArray(a) ? a : [])

// Приводит любой (в т.ч. враждебный) payload к валидному, безопасному объекту report.
function sanitizeReport(p) {
  return {
    org: clean(p.org, 160),
    program: clean(p.program, 160),
    programArea: AREAS.includes(p.programArea) ? p.programArea : 'Community Support',
    donor: clean(p.donor || 'Chevron', 80),
    period: clean(p.period, 80),
    cities: cleanArr(p.cities).filter(c => CITIES.includes(c)).slice(0, 6),
    metrics: {
      peopleReached: cleanInt(p.metrics?.peopleReached),
      events: cleanInt(p.metrics?.events),
      budgetSpent: clean(p.metrics?.budgetSpent || '—', 60),
    },
    activities: cleanArr(p.activities).slice(0, 40).map(a => ({
      date: clean(a?.date, 40), city: clean(a?.city, 40), desc: clean(a?.desc, 400),
    })),
    results: clean(p.results, 4000),
    quotes: cleanArr(p.quotes).slice(0, 20).map(q => ({
      text: clean(q?.text, 600), source: clean(q?.source, 120),
    })),
    risks: cleanArr(p.risks).slice(0, 20)
      .map(r => ({ severity: SEVERITIES.includes(r?.severity) ? r.severity : 'medium', desc: clean(r?.desc, 600) }))
      .filter(r => r.desc),
    dataGaps: cleanArr(p.dataGaps).slice(0, 20).map(g => clean(g, 300)).filter(Boolean),
    reportMarkdown: cleanMarkdown(p.reportMarkdown),
  }
}

// Транслитерация не делаем — просто нормализуем строку в безопасный для id кусок:
// нижний регистр, пробелы и спецсимволы → дефис, обрезка повторов/краёв.
function slugify(str) {
  return String(str)
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

// Простой детерминированный хеш строки (djb2-подобный) — БЕЗ Date.now/Math.random,
// нужен только чтобы разные отчёты с одинаковым org+program не схлопнулись в один id.
function hashSuffix(str) {
  let hash = 5381
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) >>> 0
  }
  return hash.toString(36).slice(0, 5)
}

// Короткий суффикс = счётчик (длина текущего массива) + хеш строки — детерминированно и уникально.
function makeId(org, program, count) {
  const base = `${slugify(org)}-${slugify(program)}`
  const suffix = `${count.toString(36)}${hashSuffix(`${org}|${program}|${count}`)}`
  return `${base}-${suffix}`
}

// ---- конец копии ----

async function reports(req) {
  if (req.method === 'GET') return json({ reports: seedReports })
  if (req.method !== 'POST') return json({ error: 'Метод не поддерживается' }, 405)
  let payload
  try { payload = await req.json() } catch { return json({ error: 'Некорректный запрос' }, 400) }
  if (!payload || !payload.org || !payload.program) return json({ error: 'Обязательные поля: org, program' }, 400)
  const safe = sanitizeReport(payload)
  const count = seedReports.filter(r => !(r.org === safe.org && r.program === safe.program)).length
  return json({
    report: { ...safe, id: makeId(safe.org, safe.program, count), submittedAt: new Date().toISOString(), status: 'submitted' },
  })
}

export default {
  async fetch(req, env) {
    const { pathname } = new URL(req.url)
    if (pathname === '/api/reports') return reports(req)
    if (pathname === '/api/extract') {
      if (!env.ANTHROPIC_API_KEY) {
        return json({ error: 'Живой AI-разбор отключён в этом демо: не задан ANTHROPIC_API_KEY.' }, 503)
      }
      return extract(req) // читает process.env.ANTHROPIC_API_KEY (nodejs_compat заполняет process.env)
    }
    if (pathname.startsWith('/api/')) return json({ error: 'Not found' }, 404)
    return env.ASSETS.fetch(req)
  },
}
