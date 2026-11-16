// Guards for state restored from localStorage / sessionStorage. Saved JSON can be valid yet have the wrong shape (an
// older version of the app, a hand edit, a half-written value), and the stores use it at import time, before React
// renders anything: one bad plan used to blank every view. Each store keeps only what is valid and drops the rest.

type Rec = Record<string, unknown>

export const isRecord = (x: unknown): x is Rec => typeof x === 'object' && x !== null && !Array.isArray(x)
const isStr = (x: unknown): x is string => typeof x === 'string'
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)

const isSite = (x: unknown) => isRecord(x) && isStr(x.id) && isStr(x.name) && isNum(x.lat) && isNum(x.lon)

/** The team's Scenario (types.ts): site, landing time, duration and requirements. */
export const isScenario = (x: unknown) =>
  isRecord(x) && isSite(x.site) && isStr(x.landing_utc) && isNum(x.duration_days) && isRecord(x.requirements)

/** A saved Mission Planner plan (usePlansStore). */
export const isPlan = (x: unknown) => isRecord(x) && isStr(x.id) && isStr(x.name) && isScenario(x.scenario)

/** A comparison workspace scenario (useCompareStore). */
export const isComparisonScenario = (x: unknown) =>
  isScenario(x) && isRecord(x) && isStr(x.id) && isStr(x.label) && isStr(x.name) && isRecord(x.spacecraft) && isStr(x.origin) && isNum(x.colorSlot)

/** A Mission Assistant message (useAssistant). */
export const isChatMessage = (x: unknown) =>
  isRecord(x) && isStr(x.id) && isStr(x.content) && isNum(x.at) && ['user', 'assistant', 'notice', 'basic'].includes(x.role as string)

export const isRescueContext = (x: unknown) => isRecord(x) && isRecord(x.roles) && Array.isArray(x.change) && isStr(x.summary)

export const isString = isStr

type Checks = Record<string, (x: unknown) => boolean>

/**
 * A zustand `persist` merge that never trusts the saved state. A saved field is kept only when it holds the same
 * kind of value as the store's default (list, object, string, number, boolean; a string or object where the default
 * is null). `checks` validate further: a list keeps only the items that pass, any other value is dropped if it fails.
 */
export function guardedMerge<T extends object>(checks: Checks = {}) {
  return (persisted: unknown, current: T): T => {
    if (!isRecord(persisted)) return current
    const out: Rec = { ...(current as Rec) }
    for (const [k, v] of Object.entries(persisted)) {
      if (!(k in current)) continue
      const d = (current as Rec)[k]
      if (typeof d === 'function') continue
      const sameKind = Array.isArray(d) ? Array.isArray(v)
        : d === null ? v === null || isStr(v) || isRecord(v)
        : isRecord(d) ? isRecord(v)
        : typeof v === typeof d && (typeof v !== 'number' || Number.isFinite(v))
      if (!sameKind) continue
      const check = checks[k]
      if (Array.isArray(v)) out[k] = check ? v.filter(check) : v
      else if (v === null || !check || check(v)) out[k] = v
    }
    return out as T
  }
}
