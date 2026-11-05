import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

import type { RibbonCache, RibbonLimit, RibbonTtl, RibbonTtlInfo } from '../types'

// ── State ────────────────────────────────────────────────────────────────
// Everything the band draws from lives in $.state, so a reload keeps it.

const EMPTY_CACHE: RibbonCache = { lastAt: null, hadCache: false, hit: null }

const limitsA = atom({ plugin: 'limits-ribbon', key: 'limits' } as const, [] as RibbonLimit[])
const cacheA = atom({ plugin: 'limits-ribbon', key: 'cache' } as const, EMPTY_CACHE)
const ctxA = atom({ plugin: 'limits-ribbon', key: 'contextTokens' } as const, null as number | null)
const ttlA = atom(
  { plugin: 'limits-ribbon', key: 'ttl' } as const,
  { value: '5m', source: 'default' } as RibbonTtlInfo,
)
const engineTtlA = atom({ plugin: 'limits-ribbon', key: 'engineTtl' } as const, null as RibbonTtl | null)
const tickA = atom({ plugin: 'limits-ribbon', key: 'tick' } as const, 0)

const TTL_MS: Record<RibbonTtl, number> = { '5m': 5 * 60_000, '1h': 60 * 60_000 }
const isTtl = (v: unknown): v is RibbonTtl => v === '5m' || v === '1h'

// ── Cache lifetime: the same order Claude Code itself resolves it in ────

async function resolveTtl(
  $: EngineInterface,
  option: string,
  limits: RibbonLimit[],
  engineTtl: RibbonTtl | null,
): Promise<RibbonTtlInfo> {
  if (isTtl(option)) return { value: option, source: 'set in the ribbon’s options' }
  if (engineTtl) return { value: engineTtl, source: 'reported by Claude Code' }
  if ((await $.env.get('FORCE_PROMPT_CACHING_5M')) === '1') {
    return { value: '5m', source: 'FORCE_PROMPT_CACHING_5M' }
  }
  const fromEnv = await $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL')
  if (isTtl(fromEnv)) return { value: fromEnv, source: 'CLAUDE_CODE_PROMPT_CACHE_TTL' }
  try {
    const fromSettings: unknown = await $.settings.read({ key: 'promptCacheTtl' })
    if (isTtl(fromSettings)) return { value: fromSettings, source: 'promptCacheTtl setting' }
  } catch {
    // settings unreadable: fall through to the plan default
  }
  if ((await $.env.get('ENABLE_PROMPT_CACHING_1H')) === '1') {
    return { value: '1h', source: 'ENABLE_PROMPT_CACHING_1H' }
  }
  const onPlan = limits.some(l => l.kind === 'five_hour' || l.kind === 'seven_day')
  const overPlan = limits.some(l => l.kind !== 'spend_limit' && l.percentUsed >= 100)
  if (onPlan && !overPlan) return { value: '1h', source: 'subscription default' }
  if (onPlan) return { value: '5m', source: 'over plan usage, on credits' }
  return { value: '5m', source: 'API default' }
}

const toLimit = (l: SessionRateLimit): RibbonLimit => ({
  kind: l.kind,
  percentUsed: l.percentUsed,
  resetsAt: l.resetsAt,
})

// ── View model ──────────────────────────────────────────────────────────

type Ramp = readonly [number, number]
type Tone = 'ok' | 'mid' | 'crit'

const RAMPS: Record<Tone | 'warm' | 'expiring', Ramp> = {
  ok: [0x0f766e, 0x2dd4bf],
  mid: [0xb45309, 0xf59e0b],
  crit: [0xb91c1c, 0xef4444],
  warm: [0xc2410c, 0xf97316],
  expiring: [0xa16207, 0xeab308],
}
const TRACK = 0x6b7280
const COLD = 0x3b82f6

// Words follow the person's theme; only the gauges' own pixels are fixed colors.
const INK = { mid: 'warning', crit: 'error', warm: 'claude', expiring: 'warning', cold: 'suggestion' } as const

type GaugeView = {
  id: string
  label: string
  name: string
  left: number
  resetIn: number | null
  tone: Tone
}

type CacheView =
  | { state: 'waiting' }
  | { state: 'off' }
  | { state: 'active'; hit: number | null }
  | { state: 'recaching' }
  | { state: 'warm' | 'expiring'; leftMs: number; frac: number; hit: number | null }
  | { state: 'cold'; reason?: string; tokens: number | null }

type Model = {
  gauges: GaugeView[]
  cache: CacheView
  ttl: RibbonTtlInfo
  now: number
}

const KIND_ORDER = ['five_hour', 'seven_day', 'spend_limit']
const KIND_LABEL: Record<string, [string, string]> = {
  five_hour: ['5h', '5-hour limit'],
  seven_day: ['7d', 'Weekly limit'],
  spend_limit: ['$', 'Spend limit'],
}

function gaugesOf(limits: RibbonLimit[], now: number): GaugeView[] {
  const rank = (k: string) => {
    const i = KIND_ORDER.indexOf(k)
    return i === -1 ? KIND_ORDER.length : i
  }
  return [...limits]
    .sort((a, b) => rank(a.kind) - rank(b.kind))
    .map(l => {
      const [label, name] = KIND_LABEL[l.kind] ?? [l.kind.replace(/_/g, ' '), l.kind.replace(/_/g, ' ')]
      const at = l.resetsAt ? Date.parse(l.resetsAt) : NaN
      const resetIn = Number.isFinite(at) ? at - now : null
      // A window whose reset has passed starts over with the next message.
      const used = resetIn !== null && resetIn <= 0 ? 0 : l.percentUsed
      const left = Math.max(0, Math.min(100, 100 - used))
      const tone: Tone = left > 40 ? 'ok' : left > 15 ? 'mid' : 'crit'
      return { id: l.kind, label, name, left, resetIn, tone }
    })
}

function cacheOf(cache: RibbonCache, ttl: RibbonTtlInfo, tokens: number | null, now: number, isWorking: boolean): CacheView {
  const ttlMs = TTL_MS[ttl.value]
  const leftMs = cache.lastAt === null ? -1 : cache.lastAt + ttlMs - now
  if (isWorking) {
    if (cache.lastAt !== null && !cache.hadCache) return { state: 'off' }
    return leftMs > 0 ? { state: 'active', hit: cache.hit } : { state: 'recaching' }
  }
  if (cache.lastAt === null) {
    return cache.coldReason ? { state: 'cold', reason: cache.coldReason, tokens } : { state: 'waiting' }
  }
  if (!cache.hadCache) return { state: 'off' }
  if (leftMs <= 0) return { state: 'cold', tokens }
  const frac = leftMs / ttlMs
  const state = leftMs < 60_000 || frac < 0.15 ? 'expiring' : 'warm'
  return { state, leftMs, frac, hit: cache.hit }
}

// ── Formatting ──────────────────────────────────────────────────────────

function fmtDur(ms: number): string {
  if (ms < 60_000) return '<1m'
  const m = Math.floor(ms / 60_000)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  const mm = m % 60
  if (h < 24) return mm ? `${h}h ${mm}m` : `${h}h`
  const d = Math.floor(h / 24)
  const hh = h % 24
  return hh ? `${d}d ${hh}h` : `${d}d`
}

function fmtClock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

const fmtCacheLeft = (ms: number) => (ms < 120_000 ? fmtClock(ms) : fmtDur(ms))

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(n)
}

const fmtReset = (g: GaugeView) => (g.resetIn === null ? '' : g.resetIn <= 0 ? 'reset' : fmtDur(g.resetIn))
const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`

function lerp(a: number, b: number, t: number): number {
  const ch = (c: number, s: number) => (c >> s) & 0xff
  const mix = (s: number) => Math.round(ch(a, s) + (ch(b, s) - ch(a, s)) * t)
  return (mix(16) << 16) | (mix(8) << 8) | mix(0)
}

function gaugeTitle(g: GaugeView): string {
  const reset = g.resetIn === null ? '' : g.resetIn <= 0 ? ', window has reset' : `, resets in ${fmtDur(g.resetIn)}`
  return `${g.name}: ${Math.round(g.left)}% left (${Math.round(100 - g.left)}% used)${reset}`
}

function cacheTitle(c: CacheView, ttl: RibbonTtlInfo): string {
  const life = `${ttl.value} lifetime, ${ttl.source}`
  const hit = (h: number | null) => (h === null ? '' : ` Last request read ${Math.round(h * 100)}% of its input from cache.`)
  switch (c.state) {
    case 'waiting':
      return 'Prompt cache: no reply yet in this session.'
    case 'off':
      return 'Prompt cache: the last response reported no cache tokens (caching off or not reported).'
    case 'active':
      return `Prompt cache warm, in use by the running turn (${life}).${hit(c.hit)}`
    case 'recaching':
      return `Prompt cache was cold; this turn is writing it again (${life}).`
    case 'warm':
    case 'expiring':
      return `Prompt cache warm, goes cold in ${fmtCacheLeft(c.leftMs)} (${life}).${hit(c.hit)}`
    case 'cold': {
      const why = c.reason ? ` (${c.reason})` : ''
      const cost = c.tokens ? ` The next request re-caches about ${fmtTokens(c.tokens)} tokens.` : ''
      return `Prompt cache cold${why}.${cost}`
    }
  }
}

// ── Terminal drawing ────────────────────────────────────────────────────

type Piece =
  | { t: 'text'; text: string; color?: string; dim?: boolean; bold?: boolean }
  | { t: 'bar'; key: string; cols: number; frac: number; ramp: Ramp }

const txt = (text: string, o: { color?: string; dim?: boolean; bold?: boolean } = {}): Piece => ({ t: 'text', text, ...o })
const widthOf = (ps: Piece[]) => ps.reduce((n, p) => n + (p.t === 'text' ? [...p.text].length : p.cols), 0)

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
function base64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out += B64.charAt((n >> 18) & 63) + B64.charAt((n >> 12) & 63)
    out += i + 1 < bytes.length ? B64.charAt((n >> 6) & 63) : '='
    out += i + 2 < bytes.length ? B64.charAt(n & 63) : '='
  }
  return out
}

/** A thin line gauge: ━ filled, ╾ a half cell, ─ the track; filled cells on a gradient. */
function barCells(cols: number, frac: number, ramp: Ramp): string {
  const halves = frac > 0 ? Math.max(1, Math.round(frac * cols * 2)) : 0
  const words = new Uint32Array(cols * 3)
  const lit = Math.ceil(halves / 2)
  for (let i = 0; i < cols; i++) {
    const filled = halves - i * 2
    // The gradient spans the lit cells, so even a short fill ends bright.
    const color = lerp(ramp[0], ramp[1], lit <= 1 ? 1 : i / (lit - 1))
    words[i * 3] = filled >= 2 ? 0x2501 : filled === 1 ? 0x257e : 0x2500
    words[i * 3 + 1] = filled >= 1 ? color : TRACK
    words[i * 3 + 2] = 0x01000000
  }
  return base64(new Uint8Array(words.buffer))
}

type Tier = 0 | 1 | 2 | 3

function gaugePieces(g: GaugeView, tier: Tier): Piece[] {
  const pct = `${Math.round(g.left)}%`
  const pctStyle = g.tone === 'ok' ? {} : { color: INK[g.tone], bold: g.tone === 'crit' }
  const reset = fmtReset(g)
  if (tier === 3) return [txt(`${g.label} `, { dim: true }), txt(pct, pctStyle)]
  const cols = tier === 0 ? 12 : tier === 1 ? 8 : 5
  const ps: Piece[] = [
    txt(`${g.label} `, { dim: true }),
    { t: 'bar', key: `bar-${g.id}`, cols, frac: g.left / 100, ramp: RAMPS[g.tone] },
    txt(` ${pct}`, pctStyle),
  ]
  if (tier === 0) ps.push(txt(' left', { dim: true }))
  if (tier <= 1 && reset) ps.push(txt(` ↻ ${reset}`, { dim: true }))
  return ps
}

function cachePieces(c: CacheView, tier: Tier): Piece[] {
  const head = tier <= 1 ? [txt('cache ', { dim: true })] : []
  switch (c.state) {
    case 'waiting':
      return [...head, txt('○', { dim: true }), txt(tier <= 1 ? ' waiting for first reply' : ' —', { dim: true })]
    case 'off':
      return [...head, txt('○', { dim: true }), txt(' not reported', { dim: true })]
    case 'active': {
      const ps = [...head, txt('●', { color: INK.warm }), txt(' active')]
      if (tier === 0 && c.hit !== null) ps.push(txt(` · ${Math.round(c.hit * 100)}% hit`, { dim: true }))
      return ps
    }
    case 'recaching':
      return [...head, txt('◌', { color: INK.cold }), txt(' re-caching…', { dim: true })]
    case 'warm':
    case 'expiring': {
      const ramp = RAMPS[c.state]
      const ps: Piece[] = [...head, txt('●', { color: INK[c.state] }), txt(' warm')]
      if (tier <= 2) ps.push(txt(' '), { t: 'bar', key: 'bar-cache', cols: tier === 0 ? 8 : 6, frac: c.frac, ramp })
      ps.push(txt(` ${fmtCacheLeft(c.leftMs)}`, c.state === 'expiring' ? { color: INK.expiring } : { dim: true }))
      if (tier === 0 && c.hit !== null) ps.push(txt(` · ${Math.round(c.hit * 100)}% hit`, { dim: true }))
      return ps
    }
    case 'cold': {
      const ps: Piece[] = [...head, txt('○', { color: INK.cold }), txt(' cold', { color: INK.cold })]
      if (tier <= 1 && c.reason) ps.push(txt(` · ${c.reason}`, { dim: true }))
      else if (tier <= 1 && c.tokens) ps.push(txt(` · ~${fmtTokens(c.tokens)} to re-cache`, { dim: true }))
      return ps
    }
  }
}

function layout(m: Model, columns: number): Piece[] {
  const gap = (tier: Tier) => txt(tier <= 1 ? '   ' : '  ')
  let line: Piece[] = []
  for (const tier of [0, 1, 2, 3] as Tier[]) {
    const segs = [...m.gauges.map(g => gaugePieces(g, tier)), cachePieces(m.cache, tier)]
    line = segs.flatMap((s, i) => (i === 0 ? s : [gap(tier), ...s]))
    if (widthOf(line) <= columns) return line
  }
  return line
}

// ── Desktop drawing ─────────────────────────────────────────────────────

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function svgBar(id: string, w: number, h: number, frac: number, ramp: Ramp, title: string): string {
  const fw = frac > 0 ? Math.max(h, frac * w) : 0
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<title>${esc(title)}</title>` +
    `<defs><linearGradient id="g-${id}" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="${w}" y2="0">` +
    `<stop offset="0" stop-color="${hex(ramp[0])}"/><stop offset="1" stop-color="${hex(ramp[1])}"/></linearGradient>` +
    `<clipPath id="c-${id}"><rect width="${w}" height="${h}" rx="${h / 2}"/></clipPath></defs>` +
    `<g clip-path="url(#c-${id})"><rect width="${w}" height="${h}" fill="rgba(128,128,128,0.24)"/>` +
    `<rect width="${fw.toFixed(1)}" height="${h}" rx="${h / 2}" fill="url(#g-${id})"/></g></svg>`
  )
}

function svgRing(size: number, frac: number, color: number, title: string, hollow: boolean): string {
  const c = size / 2
  const r = c - 1.5
  const len = 2 * Math.PI * r
  const arc = hollow
    ? `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${hex(color)}" stroke-width="1.5"/>`
    : `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${hex(color)}" stroke-width="2" stroke-linecap="round" ` +
      `stroke-dasharray="${(frac * len).toFixed(2)} ${len.toFixed(2)}" transform="rotate(-90 ${c} ${c})"/>` +
      `<circle cx="${c}" cy="${c}" r="${(r - 2.5).toFixed(2)}" fill="${hex(color)}" opacity="0.9"/>`
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    `<title>${esc(title)}</title>` +
    `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="rgba(128,128,128,0.28)" stroke-width="2"/>` +
    `${arc}</svg>`
  )
}

// ── Timers and refreshes ────────────────────────────────────────────────
// Module variables start over on a reload, as do the timers; register and
// session.start run again then and set both back up.

let ttlOption = 'auto'
let timer: { cancel: () => void } | undefined

async function refreshTtl($: EngineInterface) {
  const [limits, engineTtl] = await Promise.all([read($, limitsA), read($, engineTtlA)])
  const ttl = await resolveTtl($, ttlOption, limits, engineTtl)
  await update($, ttlA, () => ttl)
}

/** One timer: every second in the last two minutes of a warm cache, else every 15s. */
async function schedule($: EngineInterface) {
  timer?.cancel()
  const [cache, ttl] = await Promise.all([read($, cacheA), read($, ttlA)])
  const now = await $.clock.now()
  let delay = 15_000
  if (cache.lastAt !== null && cache.hadCache) {
    const left = cache.lastAt + TTL_MS[ttl.value] - now
    if (left > 0 && left <= 120_000) delay = Math.max(250, left % 1000 || 1000)
    else if (left > 120_000) delay = Math.min(delay, left - 120_000 + 50)
  }
  timer = $.clock.after(delay, () => {
    void tickThenSchedule($, now + delay)
  })
}

async function tickThenSchedule($: EngineInterface, at: number) {
  try {
    await update($, tickA, () => at)
    await schedule($)
  } catch {
    // a dropped tick only delays the next redraw
  }
}

// ── The mod ─────────────────────────────────────────────────────────────

export const register: Register = (on, options) => {
  ttlOption = String(options.cacheTtl ?? 'auto')

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const usage = await $.session.usage()
    await update($, limitsA, () => usage.rateLimits.map(toLimit))
    await update($, ctxA, () => usage.context.tokens ?? null)
    await refreshTtl($)
    await schedule($)
    return result
  })

  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    if (e.changed.includes('rateLimits')) {
      await update($, limitsA, () => e.rateLimits.map(toLimit))
      await refreshTtl($)
    }
    if (e.changed.includes('context')) await update($, ctxA, () => e.context.tokens ?? null)
    return result
  })

  // Every main-thread API response refreshes the cache's lifetime.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    try {
      if (e.agentId === undefined && result.usage) {
        const u = result.usage
        const cached = u.cache_read_input_tokens + u.cache_creation_input_tokens
        const total = cached + u.input_tokens
        const at = await $.clock.now()
        await update($, cacheA, () => ({
          lastAt: at,
          hadCache: cached > 0,
          hit: total > 0 ? u.cache_read_input_tokens / total : null,
        }))
        await schedule($)
      }
    } catch {
      // The ribbon never stands in the way of a response.
    }
    return result
  })

  on('classic.SessionStart', async ($, e, next) => {
    const result = await next(e)
    try {
      if ((e.source === 'resume' || e.source === 'fork') && typeof e.seconds_since_last_response === 'number') {
        const now = await $.clock.now()
        const idle = e.seconds_since_last_response * 1000
        await update($, cacheA, () =>
          e.prompt_cache_likely_expired
            ? { ...EMPTY_CACHE, coldReason: `idle ${fmtDur(idle)} before resume` }
            : { lastAt: now - idle, hadCache: true, hit: null },
        )
        await schedule($)
      }
    } catch {
      // observing only: the session starts whatever happens here
    }
    return result
  })

  // A switch starts a fresh cache for the new model; Claude Code also says which TTL it uses.
  on('classic.PostModelSwitch', async ($, e, next) => {
    const result = await next(e)
    try {
      await update($, engineTtlA, () => e.cache_ttl)
      if (e.source !== 'resume' && e.from_model !== e.to_model) {
        await update($, cacheA, () => ({ ...EMPTY_CACHE, coldReason: 'model switched' }))
      }
      await refreshTtl($)
    } catch {
      // observing only
    }
    return result
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') await update($, cacheA, () => EMPTY_CACHE)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    if (e.surface !== 'terminal' && e.surface !== 'desktop') return next(e)

    const [limits, cache, ttl, tokens] = await Promise.all([
      read($, limitsA),
      read($, cacheA),
      read($, ttlA),
      read($, ctxA),
      read($, tickA),
    ])
    const now = await $.clock.now()
    const m: Model = {
      gauges: gaugesOf(limits, now),
      cache: cacheOf(cache, ttl, tokens, now, e.props.isWorking),
      ttl,
      now,
    }

    if (e.surface === 'terminal') {
      const { Box, Text, Raster } = $.ui.resolve(e)
      const pieces = layout(m, e.props.bodyColumns)
      return (
        <Box flexDirection="row">
          {pieces.map((p, i) =>
            p.t === 'bar' ? (
              <Raster key={p.key} columns={p.cols} rows={1} cells={barCells(p.cols, p.frac, p.ramp)} />
            ) : (
              <Text key={`t${i}`} color={p.color} dimColor={p.dim} bold={p.bold} wrap="truncate-end">
                {p.text}
              </Text>
            ),
          )}
        </Box>
      )
    }

    const { Box, Text, Svg } = $.ui.resolve(e)
    const c = m.cache
    const cacheWord =
      c.state === 'warm' || c.state === 'expiring'
        ? 'warm'
        : c.state === 'active'
          ? 'active'
          : c.state === 'recaching'
            ? 're-caching…'
            : c.state === 'cold'
              ? 'cold'
              : c.state === 'off'
                ? 'not reported'
                : 'waiting for first reply'
    const ringColor =
      c.state === 'warm' || c.state === 'active'
        ? RAMPS.warm[1]
        : c.state === 'expiring'
          ? RAMPS.expiring[1]
          : c.state === 'cold' || c.state === 'recaching'
            ? COLD
            : TRACK
    const ringFrac = c.state === 'warm' || c.state === 'expiring' ? c.frac : c.state === 'active' ? 1 : 0
    const cacheDetail =
      c.state === 'warm' || c.state === 'expiring'
        ? fmtCacheLeft(c.leftMs)
        : c.state === 'cold'
          ? c.reason ?? (c.tokens ? `~${fmtTokens(c.tokens)} to re-cache` : '')
          : ''
    const hit = (c.state === 'warm' || c.state === 'expiring' || c.state === 'active') && c.hit !== null ? c.hit : null

    return (
      <Box flexDirection="row" alignItems="center" columnGap={3} flexWrap="wrap">
        {m.gauges.map(g => (
          <Box key={g.id} flexDirection="row" alignItems="center" columnGap={1}>
            <Text size="caption" dimColor>
              {g.label}
            </Text>
            <Svg source={svgBar(g.id, 72, 6, g.left / 100, RAMPS[g.tone], gaugeTitle(g))} alt={gaugeTitle(g)} width={72} height={6} isInteractive />
            <Text size="caption" tabular color={g.tone === 'ok' ? undefined : INK[g.tone]} weight={g.tone === 'crit' ? 'semibold' : undefined}>
              {`${Math.round(g.left)}% left`}
            </Text>
            {fmtReset(g) ? (
              <Text size="caption" dimColor tabular>
                {`↻ ${fmtReset(g)}`}
              </Text>
            ) : null}
          </Box>
        ))}
        <Box key="cache" flexDirection="row" alignItems="center" columnGap={1}>
          <Text size="caption" dimColor>
            cache
          </Text>
          <Svg
            source={svgRing(12, ringFrac, ringColor, cacheTitle(c, m.ttl), c.state === 'cold' || c.state === 'recaching' || c.state === 'waiting' || c.state === 'off')}
            alt={cacheTitle(c, m.ttl)}
            width={12}
            height={12}
            isInteractive
          />
          <Text size="caption" color={c.state === 'cold' ? INK.cold : undefined} dimColor={c.state === 'waiting' || c.state === 'off' || c.state === 'recaching'}>
            {cacheWord}
          </Text>
          {cacheDetail ? (
            <Text size="caption" dimColor tabular color={c.state === 'expiring' ? INK.expiring : undefined}>
              {cacheDetail}
            </Text>
          ) : null}
          {hit !== null ? (
            <Text size="caption" dimColor tabular>
              {`· ${Math.round(hit * 100)}% hit`}
            </Text>
          ) : null}
        </Box>
      </Box>
    )
  })
}
