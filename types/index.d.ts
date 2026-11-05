/** One rate-limit window as the ribbon keeps it. */
export type RibbonLimit = {
  /** `five_hour`, `seven_day`, or a gateway's `spend_limit`. */
  kind: string
  /** 0 to 100 (past 100 on an exceeded spend limit). */
  percentUsed: number
  /** ISO 8601. */
  resetsAt?: string
}

export type RibbonTtl = '5m' | '1h'

/** The main conversation's prompt cache, as the last API response left it. */
export type RibbonCache = {
  /** When the last main-thread response arrived (epoch ms); null before one. */
  lastAt: number | null
  /** Whether that response read or wrote cache tokens at all. */
  hadCache: boolean
  /** Share of that request's input the cache served, 0 to 1. */
  hit: number | null
  /** Why the cache is cold before any timeout (a model switch, a resume). */
  coldReason?: string
}

export type RibbonTtlInfo = {
  value: RibbonTtl
  /** Where the value came from, shown in the desktop tooltip. */
  source: string
}

declare module 'claude-code' {
  interface PluginState {
    'limits-ribbon': {
      limits: RibbonLimit[]
      cache: RibbonCache
      contextTokens: number | null
      ttl: RibbonTtlInfo
      engineTtl: RibbonTtl | null
      tick: number
    }
  }
}
