import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const T0 = Date.parse('2026-11-05T13:00:00Z')

const band = (bodyColumns: number, isWorking = false) =>
  ({
    plugin: 'limits-ribbon',
    component: 'AbovePrompt',
    props: {
      hasSurvey: false,
      isWorking,
      maxRows: 8,
      bodyColumns,
      scroll: { offset: 0, bodyRows: 7 },
      view: {},
    },
  }) as const

/** The engine beneath the mod: a subscription 43% into its 5h window, 22% into the week. */
function engine(on: On, rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[]) {
  const clock = mock.clock(on, { now: T0 })
  mock.env(on, {})
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({
    value: { startedAt: T0, context: { tokens: 182_000, window: 200_000, percent: 91 }, rateLimits },
  }))
  on('settings.read', () => ({ value: {} }))
  on('classic.SessionStart', () => ({}))
  on('classic.PostModelSwitch', () => ({}))
  return clock
}

const SUB = [
  { kind: 'five_hour', percentUsed: 43, resetsAt: new Date(T0 + (2 * 60 + 14) * 60_000).toISOString() },
  { kind: 'seven_day', percentUsed: 22, resetsAt: new Date(T0 + (3 * 24 + 4) * 3_600_000).toISOString() },
]

test('limits read as what is left, with the time to reset', async ($, on) => {
  engine(on, SUB)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...band(140), surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /57%/ }))?.text).toBe(' 57%')
  expect(await ui.find({ type: 'Text', text: /↻ 2h 14m/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /↻ 3d 4h/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /waiting for first reply/ })).toBeDefined()
  await ui.unmount()

  const desk = await $.ui.mount({ ...band(140), surface: 'desktop' })
  expect(await desk.find({ type: 'Text', text: /^57% left$/ })).toBeDefined()
  expect(await desk.find({ type: 'Text', text: /^78% left$/ })).toBeDefined()
  await desk.unmount()
})

test('a resumed session inside the hour is warm, and counts down on a subscription', async ($, on) => {
  const clock = engine(on, SUB)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 600, prompt_cache_likely_expired: false })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...band(140), surface })
    expect(await ui.find({ type: 'Text', text: /warm/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /50m/ })).toBeDefined()
    await ui.unmount()
  }

  // 49 minutes on: into the last two minutes, counted in seconds.
  await clock.advance(49 * 60_000)
  const ui = await $.ui.mount({ ...band(140), surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /1:00/ })).toBeDefined()
  await clock.advance(61_000)
  expect(await ui.find({ type: 'Text', text: / cold/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /~182k to re-cache/ })).toBeDefined()
  await ui.unmount()
})

test('an API-key session (no limits) gets the five-minute lifetime and only the cache', async ($, on) => {
  engine(on, [])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 240, prompt_cache_likely_expired: false })

  const ui = await $.ui.mount({ ...band(140), surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /5h/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /1:00/ })).toBeDefined()
  await ui.unmount()
})

test('a model switch turns the cache cold and says why', async ($, on) => {
  engine(on, SUB)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 30, prompt_cache_likely_expired: false })
  await $.classic.PostModelSwitch({
    from_model: 'claude-opus-5-5',
    to_model: 'claude-sonnet-5-5',
    requested_model: 'sonnet',
    source: 'command',
    context_tokens: 182_000,
    prompt_cache_warm: true,
    cache_ttl: '1h',
    estimated_cache_write_usd: 1.1,
    pricing: 'catalog',
  })

  const ui = await $.ui.mount({ ...band(140), surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /model switched/ })).toBeDefined()
  await ui.unmount()
})

test('a narrow band drops detail rather than wrapping', async ($, on) => {
  engine(on, SUB)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...band(40), surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /↻/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /57%/ })).toBeDefined()
  await ui.unmount()
})

test('the ttl option overrides the plan default', { options: { cacheTtl: '5m' } }, async ($, on) => {
  engine(on, SUB)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 600, prompt_cache_likely_expired: false })

  const ui = await $.ui.mount({ ...band(140), surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: / cold/ })).toBeDefined()
  await ui.unmount()
})
