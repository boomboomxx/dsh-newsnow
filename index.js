/**
 * Host half of the NewsNow hot-news bundle.
 *
 * One service (`NewsNowService`) owns every network call, the in-memory cache,
 * and the source registry. Three faces expose it without duplicating logic:
 *   - `POST /api/dsh-newsnow/feed`  — the browser panel (same-origin, cookie authenticated)
 *   - the agent tool `newsnow_news`  — the agent reads the same feed
 *   - a startup warm-up            — the first panel open is already filled
 *
 * Data comes from the public NewsNow deployment API (github.com/newsnext/newsnow):
 *   GET <baseUrl>/api/s?id=<sourceId>  ->  { status, id, updatedTime, items[] }
 *
 * This module deliberately imports nothing: a bundle installed by path from a
 * directory outside the profile resolves bare specifiers against that directory,
 * where the profile's dependencies are invisible. `Config` is therefore a
 * Standard-Schema object written by hand (the Cordis loader validates it through
 * `Config['~standard'].validate` before `apply` runs).
 */

/** Bundle display title used in log lines and tool descriptions. */
const PLUGIN = 'newsnow'

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Durable panel state, stored as JSON in the Harness data directory
 * (`<DSH_HOME|~/.dsh>/storages/dsh-newsnow.json`). `Config` only reaches the
 * process through the profile patch, so toggles made in the UI would otherwise
 * evaporate on restart. This store keeps the operator's *live* state — the
 * enabled-source order, custom sources, and the two panel preferences — which
 * survives restarts and is shared by every profile. Writes are debounced and
 * atomic (tmp file + rename).
 *
 * Node built-in specifiers resolve regardless of package layout, so these
 * imports keep the "imports nothing else" property of the bundle.
 */
function resolveStorageFile() {
  const envHome = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  const home = envHome !== '' ? envHome : path.join(os.homedir(), '.dsh')
  return path.join(home, 'storages', 'dsh-newsnow.json')
}

/**
 * The client module keeps no inline UI strings: they live in this package's
 * `locale/<id>.json` files ("text" section) and are served to the browser over
 * the `/api/dsh-newsnow/text` route registered below. The ids mirror the
 * Harness language catalog (zh, en plus the ja/es/fr/de/ru/pt packs shipped by
 * dsh-client-locale), so the panel follows whatever language the Harness UI
 * uses. Read once at module load; a missing file simply drops that language
 * (the client falls back to key echo instead of failing).
 */
const LOCALE_IDS = ['zh', 'en', 'ja', 'es', 'fr', 'de', 'ru', 'pt']

function loadLocaleFiles() {
  const text = {}
  for (const id of LOCALE_IDS) {
    try {
      const parsed = JSON.parse(fs.readFileSync(new URL(`./locale/${id}.json`, import.meta.url), 'utf8'))
      if (parsed !== null && typeof parsed.text === 'object' && parsed.text !== null) text[id] = parsed.text
    } catch {
      /* absent or unparsable dictionary: serve the remaining languages */
    }
  }
  return text
}

const CLIENT_TEXT = loadLocaleFiles()

/** Package version, read once so the live runtime can be identified from outside. */
const PLUGIN_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version ?? 'unknown'
  } catch {
    return 'unknown'
  }
})()

function createPersistentStore(ctx) {
  const file = resolveStorageFile()
  let state = { version: 1, enabled: [], custom: [], prefs: {} }
  let loaded = false
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (parsed !== null && typeof parsed === 'object') {
      state = {
        version: 1,
        enabled: Array.isArray(parsed.enabled) ? parsed.enabled.filter((id) => typeof id === 'string') : [],
        custom: Array.isArray(parsed.custom) ? parsed.custom.filter((entry) => entry !== null && typeof entry === 'object') : [],
        prefs: parsed.prefs !== null && typeof parsed.prefs === 'object' ? parsed.prefs : {},
      }
      loaded = true
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') ctx.logger?.warn?.(`${PLUGIN}: could not read ${file}: ${String(error)}`)
  }
  let timer
  const flush = () => {
    timer = undefined
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const tmp = `${file}.tmp-${process.pid}`
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2))
      fs.renameSync(tmp, file)
    } catch (error) {
      ctx.logger?.warn?.(`${PLUGIN}: could not write ${file}: ${String(error)}`)
    }
  }
  return {
    file,
    /** True when an existing state file was successfully read. */
    get loaded() {
      return loaded
    },
    get: () => state,
    patch(partial) {
      state = { ...state, ...partial }
      if (timer === undefined) {
        timer = setTimeout(flush, 250)
        if (typeof timer.unref === 'function') timer.unref()
      }
      return state
    },
    /** Write through immediately (used on plugin teardown). */
    flushNow() {
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      flush()
    },
  }
}

/**
 * Overlay the persisted state onto the process Config. The persisted state is
 * the operator's live intent, so a previously saved state file wins over
 * `Config.sources`: the saved enabled order (filtered to sources that still
 * exist) becomes the panel order, and persisted custom sources merge by id
 * over Config-declared ones. Only runs when a state file was actually read —
 * a fresh install keeps the Config defaults.
 */
function applyPersistedState(service, state) {
  const custom = Array.isArray(state.custom) ? state.custom : []
  const merged = new Map((service.config.customSources ?? []).map((source) => [source.id, source]))
  for (const entry of custom) {
    const normalized = normalizeCustomSource(entry)
    if (normalized !== undefined) merged.set(normalized.id, normalized)
  }
  service.config.customSources = [...merged.values()]

  const known = new Set(service.catalog().map((source) => source.id))
  const enabled = state.enabled.filter((id) => known.has(id))
  for (const source of service.config.customSources) {
    if (!enabled.includes(source.id)) enabled.push(source.id)
  }
  service.config.sources = enabled
  service.config.disabledSources = service.catalog().map((source) => source.id).filter((id) => !enabled.includes(id))
  service.invalidate()
}

/**
 * Services this plugin reads. Declaring them keeps the wiring order explicit:
 * the plugin never touches `ctx.tools`, `ctx.webServer`, or `ctx.connection`
 * before those services exist.
 */
export const inject = ['tools', 'webServer', 'connection']

/** Default NewsNow deployment the panel reads from. */
export const DEFAULT_BASE_URL = 'https://newsnow.busiyi.world'

/** Group ids in panel order: columns then rows. */
export const GROUPS = ['tech', 'finance', 'news', 'community', 'social']

/**
 * Built-in source catalog, shaped after NewsNow's own source table: `name` is
 * the display label, `title` is the secondary badge NewsNow shows next to it,
 * `group` becomes the card's group heading, `color` picks the card accent, and
 * `type` selects the row renderer (`hottest` rows carry a rank, `realtime`
 * rows carry a timestamp and read like a wire feed).
 */
export const SOURCES = [
  // Every id below was probed against the public deployment and returned items.
  // (36Kr has no working id on this deployment: both `36kr` and `36kr-news` are rejected.)
  { id: 'zhihu', name: '知乎', title: '热榜', group: 'community', color: 'blue', type: 'hottest', home: 'https://www.zhihu.com' },
  { id: 'weibo', name: '微博', title: '热搜', group: 'social', color: 'orange', type: 'hottest', home: 'https://weibo.com' },
  { id: 'douyin', name: '抖音', title: '热点', group: 'social', color: 'pink', type: 'hottest', home: 'https://www.douyin.com' },
  { id: 'baidu', name: '百度', title: '热搜', group: 'community', color: 'blue', type: 'hottest', home: 'https://top.baidu.com' },
  { id: 'toutiao', name: '头条', title: '热榜', group: 'news', color: 'red', type: 'hottest', home: 'https://www.toutiao.com' },
  { id: 'thepaper', name: '澎湃新闻', title: '热榜', group: 'news', color: 'red', type: 'hottest', home: 'https://www.thepaper.cn' },
  { id: 'cls', name: '财联社', title: '电报', group: 'finance', color: 'red', type: 'realtime', home: 'https://www.cls.cn' },
  { id: 'jin10', name: '金十数据', title: '快讯', group: 'finance', color: 'yellow', type: 'realtime', home: 'https://www.jin10.com' },
  { id: 'wallstreetcn', name: '华尔街见闻', title: '快讯', group: 'finance', color: 'violet', type: 'realtime', home: 'https://wallstreetcn.com' },
  { id: 'xueqiu', name: '雪球', title: '热帖', group: 'finance', color: 'blue', type: 'hottest', home: 'https://xueqiu.com' },
  { id: 'hackernews', name: 'Hacker News', title: 'Top', group: 'tech', color: 'orange', type: 'hottest', home: 'https://news.ycombinator.com' },
  { id: 'github', name: 'GitHub', title: 'Trending', group: 'tech', color: 'violet', type: 'hottest', home: 'https://github.com/trending' },
  { id: 'v2ex', name: 'V2EX', title: '热门', group: 'tech', color: 'blue', type: 'hottest', home: 'https://www.v2ex.com' },
  { id: 'sspai', name: '少数派', title: '热门', group: 'tech', color: 'red', type: 'hottest', home: 'https://sspai.com' },
  { id: 'juejin', name: '稀土掘金', title: '热榜', group: 'tech', color: 'blue', type: 'hottest', home: 'https://juejin.cn' },
  { id: 'ithome', name: 'IT 之家', title: '热榜', group: 'tech', color: 'red', type: 'hottest', home: 'https://www.ithome.com' },
  { id: 'solidot', name: 'Solidot', title: '科技', group: 'tech', color: 'green', type: 'realtime', home: 'https://www.solidot.org' },
  { id: 'hupu', name: '虎扑', title: '热帖', group: 'community', color: 'red', type: 'hottest', home: 'https://bbs.hupu.com' },
  { id: 'tieba', name: '贴吧', title: '热议', group: 'community', color: 'blue', type: 'hottest', home: 'https://tieba.baidu.com' },
  { id: 'bilibili', name: '哔哩哔哩', title: '热搜', group: 'social', color: 'pink', type: 'hottest', home: 'https://www.bilibili.com' },
  { id: 'douban', name: '豆瓣', title: '热门电影', group: 'social', color: 'green', type: 'hottest', home: 'https://movie.douban.com' },
  { id: 'tencent', name: '腾讯新闻', title: '综合早报', group: 'news', color: 'blue', type: 'hottest', home: 'https://news.qq.com' },
  { id: 'ifeng', name: '凤凰网', title: '热点资讯', group: 'news', color: 'red', type: 'hottest', home: 'https://www.ifeng.com' },
  { id: 'zaobao', name: '联合早报', group: 'news', color: 'red', type: 'realtime', home: 'https://www.zaobao.com' },
  { id: 'cankaoxiaoxi', name: '参考消息', group: 'news', color: 'red', type: 'realtime', home: 'https://www.cankaoxiaoxi.com' },
  { id: 'dongqiudi', name: '懂球帝', title: '头条', group: 'community', color: 'green', type: 'realtime', home: 'https://www.dongqiudi.com' },
  { id: 'nowcoder', name: '牛客', group: 'tech', color: 'blue', type: 'hottest', home: 'https://www.nowcoder.com' },
  { id: 'freebuf', name: 'Freebuf', title: '网络安全', group: 'tech', color: 'green', type: 'hottest', home: 'https://www.freebuf.com' },
  { id: 'gelonghui', name: '格隆汇', title: '事件', group: 'finance', color: 'blue', type: 'realtime', home: 'https://www.gelonghui.com' },
  { id: 'mktnews', name: 'MKTNews', title: '快讯', group: 'finance', color: 'indigo', type: 'realtime' },
  { id: 'fastbull', name: '法布财经', title: '快讯', group: 'finance', color: 'emerald', type: 'realtime', home: 'https://www.fastbull.com' },
  { id: 'steam', name: 'Steam', title: '在线人数', group: 'community', color: 'blue', type: 'hottest', home: 'https://store.steampowered.com' },
  { id: 'producthunt', name: 'Product Hunt', group: 'tech', color: 'red', type: 'hottest', home: 'https://www.producthunt.com' },
  { id: 'iqiyi', name: '爱奇艺', title: '热播榜', group: 'social', color: 'green', type: 'hottest', home: 'https://www.iqiyi.com' },
  { id: 'qqvideo', name: '腾讯视频', title: '热搜榜', group: 'social', color: 'blue', type: 'hottest', home: 'https://v.qq.com' },
  { id: 'pcbeta', name: '远景论坛', title: 'Win11', group: 'community', color: 'blue', type: 'realtime', home: 'https://bbs.pcbeta.com' },
  { id: 'chongbuluo', name: '虫部落', title: '最新', group: 'community', color: 'green', type: 'realtime', home: 'https://www.chongbuluo.com' },
  { id: 'aihot', name: 'AIHOT', group: 'tech', color: 'blue', type: 'realtime' },
]

const SOURCE_IDS = SOURCES.map((source) => source.id)
const CATALOG = new Map(SOURCES.map((source) => [source.id, source]))

/** Accent colors the panel knows how to paint; anything else becomes neutral. */
export const COLORS = [
  'blue',
  'sky',
  'cyan',
  'teal',
  'emerald',
  'green',
  'lime',
  'yellow',
  'orange',
  'red',
  'pink',
  'violet',
  'indigo',
  'slate',
  'gray',
]

/**
 * Glass tint per colour, mirroring NewsNow's own card treatment: in light mode
 * a 500-level colour at 40% opacity over a frosted pane, in dark mode the mid
 * tone. Kept as three channel values so the panel can blend any opacity.
 */
export const TINTS = {
  blue: [59, 130, 246],
  sky: [14, 165, 233],
  cyan: [6, 182, 212],
  teal: [20, 184, 166],
  emerald: [16, 185, 129],
  green: [34, 197, 94],
  lime: [132, 204, 22],
  yellow: [234, 179, 8],
  orange: [249, 115, 22],
  red: [239, 68, 68],
  pink: [236, 72, 153],
  violet: [139, 92, 246],
  indigo: [99, 102, 241],
  slate: [100, 116, 139],
  gray: [107, 114, 128],
}

/** Defaults for every configuration field; also the schema's default values. */
const DEFAULTS = {
  baseUrl: DEFAULT_BASE_URL,
  sources: SOURCE_IDS,
  disabledSources: [],
  customSources: [],
  refreshSeconds: 300,
  requestTimeoutMs: 12000,
  userAgent: 'Mozilla/5.0 (compatible; dsh-newsnow/1.0)',
}

/** Caps that keep a hand-edited config from producing an unusable panel. */
const LIMITS = {
  sources: 200,
  customSources: 100,
  idLength: 120,
  labelLength: 80,
  refreshSeconds: [30, 3600],
  timeoutMs: [1000, 60000],
}

/** Clamp a numeric field into its documented range. */
function clampNumber(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(number)))
}

/** Cut a string to `max` code units without leaving a lone surrogate. */
function clip(value, max) {
  const text = String(value)
  if (text.length <= max) return text
  let out = text.slice(0, max)
  const last = out.charCodeAt(out.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1)
  return out
}

/**
 * Validate one source id.
 *
 * Upstream takes the id as a query parameter, so an id must survive a URL
 * round-trip unchanged and stay in a conservative charset. Rejecting here keeps
 * the panel from rendering tabs that can never load.
 */
export function normalizeSourceId(raw) {
  if (typeof raw !== 'string') return undefined
  const id = raw.trim().toLowerCase()
  if (id === '' || id.length > LIMITS.idLength) return undefined
  if (!/^[a-z0-9][a-z0-9._:-]*$/.test(id)) return undefined
  return id
}

/** Public documentation URL for a custom source, if it has one. */
function normalizeUrl(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  try {
    const url = new URL(raw.trim())
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    return url.toString()
  } catch {
    return undefined
  }
}

/** Normalize one custom source entry; returns undefined when unusable. */
export function normalizeCustomSource(raw) {
  if (raw === null || typeof raw !== 'object') return undefined
  const id = normalizeSourceId(raw.id)
  if (id === undefined) return undefined
  // A custom source may not shadow a built-in one: the built-in carries the
  // tested color/type metadata and the custom entry would silently lose it.
  if (CATALOG.has(id)) return undefined
  const name = typeof raw.name === 'string' && raw.name.trim() !== '' ? clip(raw.name.trim(), LIMITS.labelLength) : id
  const group =
    typeof raw.group === 'string' && GROUPS.includes(raw.group) ? raw.group : 'tech'
  const color = typeof raw.color === 'string' && COLORS.includes(raw.color) ? raw.color : 'blue'
  const type = raw.type === 'realtime' ? 'realtime' : 'hottest'
  const title = typeof raw.title === 'string' && raw.title.trim() !== '' ? clip(raw.title.trim(), 16) : undefined
  const home = normalizeUrl(raw.home)
  return {
    id,
    name,
    group,
    color,
    type,
    ...(title === undefined ? {} : { title }),
    ...(home === undefined ? {} : { home }),
  }
}

/** Fill one configuration object from raw user input. */
export function resolveConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}

  const customSources = []
  if (Array.isArray(input.customSources)) {
    const seen = new Set()
    for (const entry of input.customSources) {
      const normalized = normalizeCustomSource(entry)
      if (normalized === undefined || seen.has(normalized.id)) continue
      seen.add(normalized.id)
      customSources.push(normalized)
      if (customSources.length >= LIMITS.customSources) break
    }
  }

  // `sources` is the enabled list *and* its order. Unknown ids are kept when a
  // custom source declares them (order matters before the custom entry parses),
  // but dropped when nothing can ever serve them.
  const known = new Set([...SOURCE_IDS, ...customSources.map((source) => source.id)])
  const sources = []
  const seenSources = new Set()
  const declared = Array.isArray(input.sources) ? input.sources : SOURCE_IDS
  for (const id of declared) {
    const normalized = normalizeSourceId(id)
    if (normalized === undefined || !known.has(normalized) || seenSources.has(normalized)) continue
    seenSources.add(normalized)
    sources.push(normalized)
    if (sources.length >= LIMITS.sources) break
  }

  // `disabledSources` is the opposite view of the same list, kept so a toggle
  // from the panel can be written as "disable this one" without rewriting order.
  const disabledSources = []
  if (Array.isArray(input.disabledSources)) {
    for (const id of input.disabledSources) {
      const normalized = normalizeSourceId(id)
      if (normalized === undefined || !known.has(normalized) || disabledSources.includes(normalized)) continue
      disabledSources.push(normalized)
    }
  }

  return {
    baseUrl:
      typeof input.baseUrl === 'string' && input.baseUrl.trim() !== ''
        ? clip(input.baseUrl.trim(), 2048)
        : DEFAULTS.baseUrl,
    sources,
    disabledSources,
    customSources,
    refreshSeconds: clampNumber(input.refreshSeconds, ...LIMITS.refreshSeconds, DEFAULTS.refreshSeconds),
    requestTimeoutMs: clampNumber(input.requestTimeoutMs, ...LIMITS.timeoutMs, DEFAULTS.requestTimeoutMs),
    userAgent:
      typeof input.userAgent === 'string' && input.userAgent.trim() !== ''
        ? clip(input.userAgent.trim(), 512)
        : DEFAULTS.userAgent,
  }
}

/**
 * Plugin configuration, editable from the profile's cordis.patch.yml.
 *
 * Implements the Standard Schema interface directly so the loader can validate
 * it without the bundle importing a schema library.
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-newsnow',
    validate: (value) => ({ value: resolveConfig(value) }),
  },
  ...DEFAULTS,
}

/** Convert a NewsNow item `extra` object into the strings the panel shows. */
function readExtra(extra) {
  if (extra === null || typeof extra !== 'object') return {}
  const hot = typeof extra.info === 'string' && extra.info !== '' ? clip(extra.info, 64) : undefined
  const summary = typeof extra.hover === 'string' && extra.hover !== '' ? clip(extra.hover, 400) : undefined
  const date = typeof extra.date === 'string' && extra.date !== '' ? clip(extra.date, 40) : undefined
  const diff = typeof extra.diff === 'number' && Number.isFinite(extra.diff) ? extra.diff : undefined
  return { hot, summary, date, diff }
}

/**
 * The publish timestamp of a realtime item, in epoch milliseconds. Realtime
 * sources attach `pubDate` to the item itself (not `extra`), and the panel
 * renders it as a relative "N minutes ago" stamp. Zero/negative or absurd
 * values (dates beyond year 2100 in seconds) are dropped.
 */
function readPubDate(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  // Sanity window: 2000-01-01 .. 2100-01-01 in milliseconds. Anything outside
  // (0, seconds-as-ms, far future) is garbage and must not render as a stamp.
  if (value < 946684800000 || value > 4102444800000) return undefined
  return Math.round(value)
}

/**
 * Normalize one upstream payload into a Feed; throws on a malformed body.
 *
 * Items with no usable title or URL are dropped: NewsNow occasionally emits
 * entries whose `url` is an empty string, and a card row without a target is a
 * dead link.
 */
function normalizeFeed(sourceId, body) {
  if (body === null || typeof body !== 'object') throw new Error('malformed NewsNow payload')
  const status = body.status === 'cache' ? 'cache' : 'success'
  const rawItems = Array.isArray(body.items) ? body.items : []
  const items = []
  for (const raw of rawItems) {
    if (raw === null || typeof raw !== 'object') continue
    const title = typeof raw.title === 'string' ? raw.title.trim() : ''
    const url = normalizeUrl(typeof raw.url === 'string' ? raw.url : '')
    if (title === '' || url === undefined) continue
    const { hot, summary, date, diff } = readExtra(raw.extra)
    const pubDate = readPubDate(raw.pubDate)
    items.push({
      id: typeof raw.id === 'string' && raw.id !== '' ? clip(raw.id, 200) : `${items.length}`,
      title: clip(title, 500),
      url,
      ...(hot === undefined ? {} : { hot }),
      ...(summary === undefined ? {} : { summary }),
      ...(date === undefined ? {} : { date }),
      ...(diff === undefined ? {} : { diff }),
      ...(pubDate === undefined ? {} : { pubDate }),
    })
    if (items.length >= 200) break
  }
  return {
    id: sourceId,
    status,
    ...(typeof body.updatedTime === 'number' && Number.isFinite(body.updatedTime)
      ? { updatedTime: body.updatedTime }
      : {}),
    items,
  }
}

/**
 * The single owner of NewsNow data in this Host process.
 *
 * State is a plain Map of source id -> `{ feed, expiresAt, inflight }`; a cold
 * entry starts one upstream request and every concurrent caller awaits it, so a
 * burst of panel opens costs one request per source.
 */
export class NewsNowService {
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
    this.cache = new Map()
  }

  /** Configured base URL without a trailing slash. */
  get baseUrl() {
    return String(this.config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
  }

  /** Full catalog: built-ins plus configured custom sources. */
  catalog() {
    const out = SOURCES.map((source) => ({ ...source, builtin: true }))
    for (const source of this.config.customSources ?? []) out.push({ ...source, builtin: false })
    return out
  }

  /** Look up one source in the catalog. */
  describe(sourceId) {
    const id = normalizeSourceId(sourceId)
    if (id === undefined) return undefined
    return this.catalog().find((source) => source.id === id)
  }

  /**
   * Every catalog entry annotated with whether it is enabled.
   *
   * The payload the panel renders is derived from this one call, so a toggle
   * only has to rewrite `sources`; enabled order is preserved here.
   */
  listSources() {
    const enabled = Array.isArray(this.config.sources) ? this.config.sources : SOURCE_IDS
    const order = new Map()
    enabled.forEach((id, index) => order.set(id, index))
    const disabled = new Set(this.config.disabledSources ?? [])
    return this.catalog().map((source) => ({
      ...source,
      // The glass tint travels with the descriptor so the panel never has to
      // keep its own colour table in sync with the host catalog.
      tint: TINTS[source.color] ?? TINTS.blue,
      enabled: order.has(source.id) && !disabled.has(source.id),
      order: order.has(source.id) ? order.get(source.id) : Number.MAX_SAFE_INTEGER,
    }))
  }

  /** Ids that may be fetched right now: enabled, in panel order. */
  enabledIds() {
    return this.listSources()
      .filter((source) => source.enabled)
      .sort((a, b) => a.order - b.order)
      .map((source) => source.id)
  }

  /** True when `id` is enabled (and therefore fetchable). */
  isKnownSource(id) {
    const normalized = normalizeSourceId(id)
    if (normalized === undefined) return false
    return this.enabledIds().includes(normalized)
  }

  /** Fetch one source from upstream, bounded by the configured timeout. */
  async fetchUpstream(sourceId, signal) {
    const url = `${this.baseUrl}/api/s?id=${encodeURIComponent(sourceId)}`
    const timeout = AbortSignal.timeout(this.config.requestTimeoutMs)
    const composed = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    const response = await fetch(url, {
      headers: {
        accept: 'application/json',
        'user-agent': this.config.userAgent,
      },
      signal: composed,
    })
    if (!response.ok) throw new Error(`upstream HTTP ${response.status}`)
    const body = await response.json()
    if (body !== null && typeof body === 'object' && body.error === true) {
      throw new Error(typeof body.message === 'string' ? body.message : 'upstream rejected the source')
    }
    return normalizeFeed(sourceId, body)
  }

  /**
   * Read one source, from cache when fresh.
   *
   * @param {string} sourceId - enabled NewsNow source id.
   * @param {{ force?: boolean, signal?: AbortSignal }} options - `force` bypasses the freshness check.
   * @returns {Promise<object>} a Feed, or a Feed with `status: 'error'` and `error` set.
   */
  async getFeed(sourceId, options = {}) {
    const { force = false, signal } = options
    const meta = this.describe(sourceId)
    if (meta === undefined) {
      return { id: String(sourceId), status: 'error', items: [], error: `unknown source "${String(sourceId)}"` }
    }
    if (!this.isKnownSource(meta.id)) {
      return { id: meta.id, status: 'error', items: [], error: `source "${meta.id}" is disabled` }
    }
    const ttl = this.config.refreshSeconds * 1000
    const now = Date.now()
    const entry = this.cache.get(meta.id)
    if (!force && entry !== undefined && entry.expiresAt > now && !entry.inflight && entry.feed) {
      return { ...entry.feed, stale: false, fetchedAt: entry.fetchedAt }
    }
    if (entry?.inflight) return entry.inflight

    const inflight = (async () => {
      const startedAt = Date.now()
      try {
        const feed = await this.fetchUpstream(meta.id, signal)
        this.cache.set(meta.id, { feed, expiresAt: startedAt + ttl, fetchedAt: startedAt, inflight: undefined })
        return { ...feed, fetchedAt: startedAt, stale: false }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const previous = this.cache.get(meta.id)
        if (previous?.feed) {
          // Serve the last good copy rather than emptying the card on a blip.
          const failure = { ...previous.feed, stale: true, fetchedAt: previous.fetchedAt, error: message }
          this.cache.set(meta.id, {
            ...previous,
            expiresAt: Date.now() + Math.min(ttl, 60_000),
            inflight: undefined,
          })
          return failure
        }
        this.cache.set(meta.id, { feed: undefined, expiresAt: 0, fetchedAt: startedAt, inflight: undefined })
        return { id: meta.id, status: 'error', items: [], error: message, fetchedAt: startedAt }
      } finally {
        const current = this.cache.get(meta.id)
        if (current !== undefined) current.inflight = undefined
      }
    })()
    this.cache.set(meta.id, { ...(entry ?? { feed: undefined, expiresAt: 0 }), inflight })
    return inflight
  }

  /** Drop the cache entry for one source (or all of them). */
  invalidate(sourceId) {
    if (sourceId === undefined) this.cache.clear()
    else {
      const normalized = normalizeSourceId(sourceId)
      if (normalized === undefined) return
      this.cache.delete(normalized)
    }
  }
}

/** Build the JSON response helper shared by every route. */
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

/** Read a source id from a JSON body or the query string. */
function readSourceParam(body, url) {
  const fromQuery = url.searchParams.get('id')
  if (typeof fromQuery === 'string' && fromQuery !== '') return fromQuery
  if (body !== null && typeof body === 'object' && typeof body.id === 'string') return body.id
  return undefined
}

/**
 * Mutate the enabled set.
 *
 * The only durable store this plugin has is its own Config block, so a toggle
 * lives in this Host process and is reported back with `persisted: false`; the
 * response carries the exact `config` snippet an operator can paste into the
 * profile patch to make it stick across restarts.
 */
function applySourceAction(service, body, store) {
  const action = typeof body?.action === 'string' ? body.action : ''
  const config = service.config
  const enabled = service.enabledIds()

  if (action === 'enable' || action === 'disable') {
    const id = normalizeSourceId(body?.id)
    const meta = id === undefined ? undefined : service.describe(id)
    if (meta === undefined) return { ok: false, error: { code: 'unknown-source', message: `unknown source "${String(body?.id)}"` } }
    const next = new Set(enabled)
    if (action === 'enable') {
      // A re-enabled source goes to the back of the panel; keeping it in place
      // would make a just-enabled card appear in the middle of the grid.
      if (!next.has(meta.id)) next.add(meta.id)
    } else {
      next.delete(meta.id)
      service.invalidate(meta.id)
    }
    config.sources = [...next]
    config.disabledSources = service.catalog().map((source) => source.id).filter((sourceId) => !next.has(sourceId))
    store.patch({ enabled: service.enabledIds(), custom: service.config.customSources })
    return { ok: true, sources: service.listSources() }
  }

  if (action === 'add-custom') {
    const normalized = normalizeCustomSource(body?.source ?? {})
    if (normalized === undefined) {
      return {
        ok: false,
        error: {
          code: 'invalid-source',
          message: 'a custom source needs an id of [a-z0-9._:-] and must not reuse a built-in id',
        },
      }
    }
    const already = service.config.customSources.some((source) => source.id === normalized.id)
    if (already) {
      /** Re-adding the same custom source replaces its metadata, never duplicates it. */
      service.config.customSources = service.config.customSources.map((source) =>
        source.id === normalized.id ? normalized : source,
      )
      store.patch({ enabled: service.enabledIds(), custom: service.config.customSources })
      return { ok: true, sources: service.listSources() }
    }
    if (service.config.customSources.length >= LIMITS.customSources) {
      return { ok: false, error: { code: 'too-many-sources', message: `at most ${LIMITS.customSources} custom sources` } }
    }
    service.config.customSources = [...service.config.customSources, normalized]
    if (!service.isKnownSource(normalized.id)) {
      service.config.sources = [...enabled, normalized.id]
    }
    service.invalidate()
    store.patch({ enabled: service.enabledIds(), custom: service.config.customSources })
    return { ok: true, sources: service.listSources() }
  }

  if (action === 'remove-custom') {
    const id = normalizeSourceId(body?.id)
    if (id === undefined || !service.config.customSources.some((source) => source.id === id)) {
      return { ok: false, error: { code: 'unknown-source', message: `"${String(body?.id)}" is not a custom source` } }
    }
    service.config.customSources = service.config.customSources.filter((source) => source.id !== id)
    service.config.sources = enabled.filter((sourceId) => sourceId !== id)
    service.config.disabledSources = service.config.disabledSources.filter((sourceId) => sourceId !== id)
    service.invalidate(id)
    store.patch({ enabled: service.enabledIds(), custom: service.config.customSources })
    return { ok: true, sources: service.listSources() }
  }

  if (action === 'set-prefs') {
    /** Panel preferences ride the same bridge so they survive restarts too. */
    const prefs = { ...store.get().prefs }
    const raw = body?.prefs
    if (raw !== null && typeof raw === 'object') {
      if (typeof raw.autoRefresh === 'number' && Number.isFinite(raw.autoRefresh)) prefs.autoRefresh = raw.autoRefresh
      if (raw.sidebarBrowser === 'embed' || raw.sidebarBrowser === 'sidebar' || raw.sidebarBrowser === 'system') prefs.sidebarBrowser = raw.sidebarBrowser
    }
    store.patch({ prefs })
    return { ok: true }
  }

  return { ok: false, error: { code: 'unknown-action', message: `unknown action "${action}"` } }
}

/** The persisted config an operator should paste to keep panel toggles. */
function persistedConfig(service) {
  const enabled = service.enabledIds()
  return {
    sources: enabled,
    disabledSources: service.catalog().map((source) => source.id).filter((id) => !enabled.includes(id)),
    customSources: service.config.customSources,
  }
}

/** Register `/api/dsh-newsnow/*` through the connection Fetch bridge. */
function registerRoutes(ctx, service, store) {
  const connection = ctx.get('connection')
  if (connection === undefined || typeof connection.fetch?.register !== 'function') return false
  try {
    ctx.effect(
      () =>
        connection.fetch.register({
          path: '/api/dsh-newsnow/feed',
          methods: ['GET', 'POST'],
          requestBody: 'buffered',
          fetch: async (request) => {
            let body
            const contentType = request.headers.get('content-type') ?? ''
            if (contentType.includes('application/json')) {
              try {
                body = await request.json()
              } catch {
                body = undefined
              }
            }
            const url = new URL(request.url)
            const action = typeof body?.action === 'string' ? body.action : ''

            if (action !== '') {
              const result = applySourceAction(service, body, store)
              if (result.ok !== true) return json({ ok: false, error: result.error }, 400)
              return json({
                ok: true,
                sources: result.sources,
                enabled: service.enabledIds(),
                prefs: store.get().prefs,
                persisted: true,
                file: store.file,
                config: persistedConfig(service),
              })
            }

            const sourceId = readSourceParam(body, url)
            if (sourceId === undefined) {
              const enabled = service.enabledIds()
              return json({
                ok: true,
                baseUrl: service.baseUrl,
                refreshSeconds: service.config.refreshSeconds,
                sources: service.listSources().sort((a, b) => a.order - b.order),
                enabled,
                prefs: store.get().prefs,
              })
            }
            const force = url.searchParams.get('force') === '1' || body?.force === true
            const feed = await service.getFeed(sourceId, { force })
            return json({ ok: true, value: feed })
          },
        }),
      `${PLUGIN}: feed route`,
    )
    ctx.effect(
      () =>
        connection.fetch.register({
          path: '/api/dsh-newsnow/text',
          /* POST + buffered mirrors the feed route: the /api bridge builds a
           * streaming Request body unless the mode is "buffered", and a GET
           * Request cannot carry a body, so GET + "none" dies in the bridge. */
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: () => json({ ok: true, text: CLIENT_TEXT }),
        }),
      `${PLUGIN}: locale text route`,
    )
    return true
  } catch (error) {
    ctx.logger?.warn?.(`${PLUGIN}: could not register the feed route: ${String(error)}`)
    return false
  }
}

/** Register a plain `webServer` route so the panel works without the Fetch bridge. */
function registerWebRoute(ctx, service) {
  const webServer = ctx.get('webServer')
  if (webServer === undefined || typeof webServer.register !== 'function') return
  try {
    ctx.effect(
      () =>
        webServer.register({
          kind: 'prefix',
          path: '/dsh-newsnow/api',
          handler: async (req, res) => {
            const url = new URL(req.url ?? '/', 'http://localhost')
            const send = (payload, status = 200) => {
              res.writeHead(status, {
                'content-type': 'application/json; charset=utf-8',
                'cache-control': 'no-store',
              })
              res.end(JSON.stringify(payload))
            }
            if (url.pathname.endsWith('/status')) {
              /* Unauthenticated liveness probe: lets the outside world see which
               * build the running host actually has and how the locale route is
               * declared. Read-only and reveals nothing sensitive. */
              send({
                ok: true,
                version: PLUGIN_VERSION,
                textLanguages: Object.keys(CLIENT_TEXT),
                textRoute: { path: '/api/dsh-newsnow/text', methods: ['POST'], requestBody: 'buffered' },
              })
              return
            }
            if (!url.pathname.endsWith('/feed')) {
              res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
              res.end('not found')
              return
            }
            const sourceId = url.searchParams.get('id') ?? undefined
            if (sourceId === undefined) {
              send({
                ok: true,
                baseUrl: service.baseUrl,
                refreshSeconds: service.config.refreshSeconds,
                sources: service.listSources().sort((a, b) => a.order - b.order),
                enabled: service.enabledIds(),
              })
              return
            }
            const feed = await service.getFeed(sourceId, { force: url.searchParams.get('force') === '1' })
            send({ ok: true, value: feed })
          },
        }),
      `${PLUGIN}: web route`,
    )
  } catch (error) {
    ctx.logger?.warn?.(`${PLUGIN}: could not register the web route: ${String(error)}`)
  }
}

/** Register the `newsnow_news` agent tool over the same service. */
function registerTool(ctx, service) {
  if (typeof ctx.tools?.register !== 'function') return
  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'newsnow_news',
        description:
          'Read hot/trending news from an enabled NewsNow source (Zhihu, Weibo, Douyin, V2EX, Hacker News, GitHub Trending and more). ' +
          'Omit "source" to list the configured sources and whether each is enabled; pass a source id to read its current headlines.',
        parameters: {
          type: 'object',
          properties: {
            source: {
              type: 'string',
              description: 'NewsNow source id. Enabled ids are listed when this argument is omitted.',
            },
            limit: {
              type: 'integer',
              description: 'Maximum number of headlines to return (1-50, default 15).',
              minimum: 1,
              maximum: 50,
            },
            force: {
              type: 'boolean',
              description: 'Bypass the Host cache and refetch from NewsNow now.',
            },
          },
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              source: { type: 'string' },
              status: { type: 'string' },
              updatedTime: { type: 'number' },
              headlines: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    title: { type: 'string' },
                    url: { type: 'string' },
                    hot: { type: 'string' },
                  },
                },
              },
            },
          },
          render(args, value) {
            const list = Array.isArray(value?.headlines) ? value.headlines : []
            const lines = list.map(
              (item, index) => `${index + 1}. ${item.title}${item.hot ? ` (${item.hot})` : ''}\n   ${item.url}`,
            )
            if (lines.length === 0) {
              const rows = Array.isArray(value?.sources) ? value.sources : []
              if (rows.length > 0) {
                const table = rows.map(
                  (row) => `- ${row.enabled ? 'on ' : 'off'} \`${row.id}\` — ${row.name}${row.builtin ? '' : ' (custom)'}`,
                )
                return [{ type: 'text', text: `**NewsNow sources**\n\n${table.join('\n')}` }]
              }
              return [
                {
                  type: 'text',
                  text: `No headlines for ${String(value?.source ?? args?.source ?? 'this source')}.`,
                },
              ]
            }
            return [
              {
                type: 'text',
                text: `**${String(value?.source ?? args?.source)}** — ${lines.length} headlines\n\n${lines.join('\n')}`,
              },
            ]
          },
        },
        async execute(args) {
          const input = args !== null && typeof args === 'object' ? args : {}
          if (typeof input.source !== 'string' || input.source.trim() === '') {
            return {
              sources: service.listSources().map((source) => ({
                id: source.id,
                name: source.name,
                enabled: source.enabled,
                builtin: source.builtin,
              })),
              headlines: [],
            }
          }
          const limit = Math.min(50, Math.max(1, Number.isInteger(input.limit) ? input.limit : 15))
          const feed = await service.getFeed(input.source.trim(), { force: input.force === true })
          if (feed.status === 'error') {
            throw new Error(feed.error ?? `could not read "${input.source}"`)
          }
          return {
            source: feed.id,
            status: feed.status,
            ...(feed.updatedTime === undefined ? {} : { updatedTime: feed.updatedTime }),
            headlines: feed.items.slice(0, limit).map((item) => ({
              title: item.title,
              url: item.url,
              ...(item.hot === undefined ? {} : { hot: item.hot }),
            })),
          }
        },
      }),
    `${PLUGIN}: agent tool`,
  )
}

/** Warm the cache at startup so the first panel open renders immediately. */
function warmUp(ctx, service) {
  const sources = service.enabledIds().slice(0, 4)
  if (sources.length === 0) return
  ctx.effect(() => {
    let cancelled = false
    const timer = setTimeout(() => {
      void (async () => {
        for (const id of sources) {
          if (cancelled) return
          try {
            await service.getFeed(id)
          } catch {
            // A warm-up failure is not an error: the panel retries on demand.
          }
        }
      })()
    }, 1500)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, `${PLUGIN}: startup warm-up`)
}

/** Cordis plugin entry: one service, three faces. */
export function apply(ctx, config) {
  const resolved = resolveConfig(config)
  const service = new NewsNowService(ctx, resolved)
  const store = createPersistentStore(ctx)
  if (store.loaded) applyPersistedState(service, store.get())
  registerRoutes(ctx, service, store)
  registerWebRoute(ctx, service)
  registerTool(ctx, service)
  warmUp(ctx, service)
  ctx.effect(
    () => () => {
      /* A pending debounced write would be lost on shutdown — flush it. */
      store.flushNow()
    },
    `${PLUGIN}: flush persisted state`,
  )
  ctx.logger?.info?.(
    `${PLUGIN}: ${service.enabledIds().length}/${service.catalog().length} source(s) enabled from ${service.baseUrl} (refresh ${resolved.refreshSeconds}s)` +
      (store.loaded ? `, state restored from ${store.file}` : ''),
  )
}
