/**
 * @fileoverview Shelly Cloud monthly consumption dashboard.
 *
 * Layout of this file:
 *   1. Config      – everything that is specific to one household/account.
 *   2. State / DOM – single mutable state object and cached element lookups.
 *   3. Helpers     – dates, concurrency, theme colours, status line.
 *   4. API         – raw calls to the Shelly Cloud API.
 *   5. Data        – turning devices + months into consumption results.
 *   6. Cache       – localStorage cache of completed months.
 *   7. Render      – tables, pie charts, line chart, modals.
 *   8. Controller  – wiring it all together.
 *
 * Loaded as a classic script (not a module) so the page can be opened directly
 * via file:// — Chrome blocks module scripts on file:// origins.
 */
'use strict';

// ---------------------------------------------------------------------------
// 1. Config
// ---------------------------------------------------------------------------

/**
 * Household-specific configuration. Nothing below this block should need to
 * know about concrete device names, IDs or types.
 */
const CONFIG = {
  /** Shelly Cloud server for this account. */
  server: 'https://shelly-14-eu.shelly.cloud',

  /** Device type code → statistics API path segment. */
  pathByType: new Map([
    ['SPEM-003CEBEU', 'em-3p'],
    ['SPEM-002CEBEU50', 'em-3p'],
    ['SNSW-102P16EU', 'switch'],  // 'roller' when the device is in roller mode
    ['SNSW-002P16EU', 'switch'],
  ]),

  /** Fallback path for devices whose type code is not in `pathByType`. */
  pathByDeviceId: {
    'ec64c9c06a01': 'roller',
  },

  /** Text stripped from device names for display. */
  nameStrip: /Consumo/g,

  /** Channels below this (absolute) Wh are hidden from tables and pies. */
  minDisplayWh: 5,

  /**
   * Roller statistics are reported as per-minute averages, so one hour of
   * samples needs to be scaled by 60 to get Wh.
   */
  rollerFactor: 60,

  /** Max in-flight statistics requests (Shelly Cloud rate-limits). */
  maxConcurrentRequests: 4,
};

/**
 * @typedef {{
 *   mainMeter: ?string,
 *   showUnknown: boolean,
 *   unknownLabel: string,
 *   unknownMode: string,
 *   unknownSubs: !Array<string>,
 *   unknownClamp: boolean,
 *   subtractions: !Array<{target: string, subs: !Array<string>}>,
 * }} Rules
 *   Household-specific adjustments, editable in the Rules dialog:
 *   - `mainMeter`: whole-house meter; excluded from pies and used as the
 *     baseline for the "Unknown" row.
 *   - `unknownMode`: 'all' → Unknown = main − every other channel;
 *     'selected' → Unknown = main − only the channels in `unknownSubs`.
 *   - `unknownClamp`: never let Unknown go below zero.
 *   - `subtractions`: sub-meters whose consumption is already included in
 *     `target` and must be subtracted from it (applied before Unknown).
 */

/** @const {!Rules} Defaults used until the user saves their own. */
const DEFAULT_RULES = {
  mainMeter: 'Geral',
  showUnknown: true,
  unknownLabel: 'Unknown',
  unknownMode: 'all',
  unknownSubs: [],
  unknownClamp: true,
  subtractions: [
    {target: 'Rua', subs: ['Carro', 'Máquina de lavar', 'Máquina de secar']},
  ],
};

/** localStorage keys. */
const STORAGE = {
  authKey: 'shelly_auth_key',
  theme: 'shelly_theme',
  monthCache: 'shelly_month_cache_v1',
  rules: 'shelly_rules_v1',
};

/**
 * Standard Google Charts colors.
 * @const {!Array<string>}
 */
const CHART_COLORS = [
  '#3366cc', '#dc3912', '#ff9900', '#109618', '#990099', '#0099c6',
  '#dd4477', '#66aa00', '#b82e2e', '#316395', '#994499', '#22aa99',
  '#aaaa11', '#6633cc', '#e67300', '#8b0707', '#651067', '#329262',
  '#5574a6', '#3b3eac'
];

// ---------------------------------------------------------------------------
// 2. State / DOM
// ---------------------------------------------------------------------------

/**
 * @typedef {{
 *   id: ?string,
 *   name: string,
 *   consumption: ?number,
 * }} Result  Consumption in Wh; null when the fetch failed.
 */

/**
 * @typedef {{
 *   id: string,
 *   channel: ?number,
 *   name: string,
 *   path: string,
 * }} Channel
 */

/**
 * @typedef {{
 *   year: number,
 *   month: number,
 *   key: string,
 *   from: string,
 *   to: string,
 *   title: string,
 *   shortLabel: string,
 *   isComplete: boolean,
 *   elapsedFraction: number,  1 for complete months, else fraction elapsed.
 * }} MonthBounds
 */

/**
 * @typedef {{
 *   container: !HTMLElement,
 *   chart: ?google.visualization.PieChart,
 *   title: string,
 *   results: !Array<!Result>,
 * }} Pie
 */

/**
 * @typedef {{
 *   bounds: !MonthBounds,
 *   tableCard: !HTMLElement,
 *   pieCard: !HTMLElement,
 *   raw: ?Array<!Result>,       Unadjusted fetch results (null until loaded).
 *   results: !Array<!Result>,   `raw` with the current rules applied.
 *   pie: ?Pie,
 * }} MonthView
 */

const state = {
  authKey: localStorage.getItem(STORAGE.authKey) || '',
  /** @type {!Rules} */
  rules: loadRules(),
  /** @type {!Object<string, !Object>} */
  deviceList: {},
  /** @type {!Array<!MonthView>} Oldest first. */
  months: [],
  /** @type {!Set<string>} Device names plotted on the line chart. */
  selected: new Set(),
  /** @type {?Pie} The pie currently shown in the modal, if any. */
  modalPie: null,
  /** @type {?google.visualization.PieChart} */
  modalChart: null,
  /** @type {?google.visualization.LineChart} */
  lineChart: null,
  /** Incremented per render so stale async renders can bail out. */
  renderToken: 0,
};

const $ = (id) => /** @type {!HTMLElement} */ (document.getElementById(id));
const dom = {
  theme: /** @type {!HTMLSelectElement} */ ($('theme-selector')),
  range: /** @type {!HTMLSelectElement} */ ($('range-selector')),
  refresh: /** @type {!HTMLButtonElement} */ ($('refresh-btn')),
  settingsBtn: $('settings-btn'),
  rulesBtn: $('rules-btn'),
  status: $('status-message'),
  tables: $('tables-container'),
  lineChart: $('chart-container'),
  pies: $('pie-charts-container'),
  chartModal: $('chart-modal'),
  modalChart: $('modal-chart-container'),
  settingsModal: $('settings-modal'),
  apiKeyInput: /** @type {!HTMLInputElement} */ ($('api-key-input')),
  saveSettings: $('save-settings-btn'),
  // Rules dialog
  rulesModal: $('rules-modal'),
  ruleMainMeter: /** @type {!HTMLSelectElement} */ ($('rule-main-meter')),
  ruleShowUnknown: /** @type {!HTMLInputElement} */ ($('rule-show-unknown')),
  ruleUnknownLabel: /** @type {!HTMLInputElement} */ ($('rule-unknown-label')),
  ruleUnknownOptions: /** @type {!HTMLFieldSetElement} */ ($('rule-unknown-options')),
  ruleUnknownSubs: $('rule-unknown-subs'),
  ruleUnknownClamp: /** @type {!HTMLInputElement} */ ($('rule-unknown-clamp')),
  ruleUnknownFormula: $('rule-unknown-formula'),
  ruleSubtractions: $('rule-subtractions'),
  ruleAddSubtraction: $('rule-add-subtraction'),
  ruleRowTemplate: /** @type {!HTMLTemplateElement} */ ($('rule-row-template')),
  saveRules: $('save-rules-btn'),
  resetRules: $('reset-rules-btn'),
};

// ---------------------------------------------------------------------------
// 3. Helpers
// ---------------------------------------------------------------------------

const pad2 = (n) => String(n).padStart(2, '0');
const toKwh = (wh) => wh / 1000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * @param {!Result} r
 * @return {boolean} Whether the row has data and is worth showing.
 */
const isSignificant = (r) =>
    r.consumption !== null && Math.abs(r.consumption) >= CONFIG.minDisplayWh;

/**
 * Computes all the date-derived values needed for one month.
 * @param {number} year
 * @param {number} month 0-based.
 * @param {!Date=} now
 * @return {!MonthBounds}
 */
function monthBounds(year, month, now = new Date()) {
  const first = new Date(year, month, 1);
  const next = new Date(year, month + 1, 1);
  const lastDay = new Date(year, month + 1, 0).getDate();
  const ym = `${year}-${pad2(month + 1)}`;
  const isComplete = next <= now;
  // Fraction of the month elapsed, floored at one day so a projection made
  // minutes into a new month is not absurdly amplified.
  const span = next - first;
  const elapsedFraction = isComplete ?
      1 :
      Math.min(1, Math.max(MS_PER_DAY, now - first) / span);
  return {
    year,
    month,
    key: ym,
    from: `${ym}-01 00:00:00`,
    to: `${ym}-${pad2(lastDay)} 23:59:59`,
    title: `${first.toLocaleString('default', {month: 'long'})} ${year}`,
    shortLabel: first.toLocaleString('default', {month: 'short', year: '2-digit'}),
    isComplete,
    elapsedFraction,
  };
}

/**
 * Linear projection of a partial month's consumption to the full month.
 * @param {number} wh Consumption so far.
 * @param {!MonthBounds} bounds
 * @return {number}
 */
const projectToMonthEnd = (wh, bounds) => wh / bounds.elapsedFraction;

/**
 * Lists the months covered by a range selector value.
 * @param {string} range '6', '12' (months back) or 'YTD'.
 * @param {!Date=} now
 * @return {!Array<!MonthBounds>} Oldest first, ending with the current month.
 */
function monthsInRange(range, now = new Date()) {
  const start = range === 'YTD' ?
      new Date(now.getFullYear(), 0, 1) :
      new Date(now.getFullYear(), now.getMonth() - parseInt(range, 10) + 1, 1);
  const months = [];
  for (let d = start; d <= now; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) {
    months.push(monthBounds(d.getFullYear(), d.getMonth(), now));
  }
  return months;
}

/**
 * Creates a function that runs async tasks with at most `max` in flight.
 * @param {number} max
 * @return {function(function(): !Promise<T>): !Promise<T>}
 * @template T
 */
function createLimiter(max) {
  let active = 0;
  const queue = [];
  const pump = () => {
    if (active >= max || queue.length === 0) return;
    active++;
    const {task, resolve, reject} = queue.shift();
    task().then(resolve, reject).finally(() => {
      active--;
      pump();
    });
  };
  return (task) => new Promise((resolve, reject) => {
    queue.push({task, resolve, reject});
    pump();
  });
}

const limitRequests = createLimiter(CONFIG.maxConcurrentRequests);

/**
 * @param {function(): void} fn
 * @param {number} ms
 * @return {function(): void}
 */
function debounce(fn, ms) {
  let timer;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
}

/**
 * Reads the chart colours from the active CSS theme so they are defined in
 * exactly one place (the stylesheet).
 * @return {{text: string, background: string, grid: string}}
 */
function themeColors() {
  const style = getComputedStyle(document.documentElement);
  const v = (name) => style.getPropertyValue(name).trim();
  return {text: v('--text-color'), background: v('--card-bg'), grid: v('--border-color')};
}

/**
 * @param {string} message
 * @param {boolean=} isError
 */
function showStatus(message, isError = false) {
  dom.status.textContent = message;
  dom.status.classList.toggle('error', isError);
  dom.status.hidden = false;
}

function clearStatus() {
  dom.status.hidden = true;
  dom.status.textContent = '';
}

// ---------------------------------------------------------------------------
// 4. API
// ---------------------------------------------------------------------------

/**
 * Fetches the list of devices associated with the account.
 * @return {!Promise<!Object<string, !Object>>} Device list keyed by device id.
 * @throws {!Error} On HTTP or API-level failure (e.g. bad auth key).
 */
async function fetchDeviceList() {
  const response = await fetch(`${CONFIG.server}/interface/device/list`, {
    method: 'POST',
    body: new URLSearchParams({auth_key: state.authKey}),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  if (!data.isok) {
    const detail = data.errors ? JSON.stringify(data.errors) : 'check your auth key';
    throw new Error(`API rejected the request (${detail})`);
  }
  return data.data?.devices ?? {};
}

/**
 * Sums the consumption in a statistics `history` payload. The shape differs
 * per device family, so this is the only place that knows about it.
 *
 * @param {*} history The `history` field of the statistics response.
 * @param {string} path API path segment ('em-3p', 'roller', 'switch').
 * @param {?number} channel
 * @return {?number} Total Wh, or null if the payload could not be interpreted.
 */
function sumHistory(history, path, channel) {
  if (!Array.isArray(history)) return null;
  const sum = (items) => items.reduce((acc, item) => acc + (item.consumption || 0), 0);

  if (path === 'em-3p' && Array.isArray(history[0])) {
    // Pro 3EM: one history array per channel.
    const perChannel = history[channel];
    return Array.isArray(perChannel) ? sum(perChannel) : null;
  }
  if (path === 'em-3p' && history[0]?.channels) {
    // Other EM devices: flat history where each item carries a `channels` array.
    return history.reduce((acc, item) => {
      const entry = item.channels?.find((c) => Number(c.channel) === channel);
      return acc + (entry?.consumption || 0);
    }, 0);
  }
  // Everything else: the `channel` query param already filtered server-side.
  return sum(history.flat());
}

/**
 * Fetches the power consumption for a device channel over a date range.
 *
 * @param {!Channel} ch
 * @param {!MonthBounds} bounds
 * @return {!Promise<?number>} Total Wh, or null if the request failed.
 */
function fetchChannelConsumption(ch, bounds) {
  return limitRequests(async () => {
    // Note: the v2 statistics endpoint is GET-only, so the key goes in the URL.
    const url = new URL(`${CONFIG.server}/v2/statistics/power-consumption/${ch.path}`);
    url.searchParams.set('id', ch.id);
    url.searchParams.set('auth_key', state.authKey);
    url.searchParams.set('date_range', 'custom');
    url.searchParams.set('date_from', bounds.from);
    url.searchParams.set('date_to', bounds.to);
    if (ch.channel !== null) url.searchParams.set('channel', String(ch.channel));

    const label = `${ch.name} (${ch.id}/ch${ch.channel}) ${bounds.key}`;
    try {
      const response = await fetch(url);
      if (!response.ok) {
        console.warn(`Stats request failed for ${label}: HTTP ${response.status}`);
        return null;
      }
      const stats = await response.json();
      const wh = sumHistory(stats.history, ch.path, ch.channel);
      if (wh === null) {
        console.warn(`Could not interpret stats payload for ${label}`, stats);
        return null;
      }
      return ch.path === 'roller' ? wh * CONFIG.rollerFactor : wh;
    } catch (e) {
      console.warn(`Stats request errored for ${label}:`, e);
      return null;
    }
  });
}

// ---------------------------------------------------------------------------
// 5. Data
// ---------------------------------------------------------------------------

/** @param {string} listId Device-list key, e.g. 'abc123_1'. */
const baseDeviceId = (listId) => listId.split('_')[0];

/**
 * Determines the statistics API path for a device.
 * @param {!Object} entry Device-list entry (has `type`, `mode`).
 * @param {string} listId
 * @return {?string} Path segment, or null if the device is not supported.
 */
function getDevicePath(entry, listId) {
  const byType = CONFIG.pathByType.get(entry.type);
  if (byType === 'switch' && entry.mode === 'roller') return 'roller';
  if (byType) return byType;
  return CONFIG.pathByDeviceId[baseDeviceId(listId)] ?? null;
}

/**
 * Converts the raw device list into the channels we can query.
 * @param {!Object<string, !Object>} deviceList
 * @return {!Array<!Channel>}
 */
function listChannels(deviceList) {
  return Object.entries(deviceList).flatMap(([listId, entry]) => {
    const path = getDevicePath(entry, listId);
    if (!path) return [];
    return [{
      id: baseDeviceId(listId),
      channel: entry.channel == null ? null : Number(entry.channel),
      name: (entry.name || listId).replace(CONFIG.nameStrip, '').trim(),
      path,
    }];
  });
}

/**
 * Fetches (or loads from cache) the raw per-channel consumption for a month.
 * @param {!Array<!Channel>} channels
 * @param {!MonthBounds} bounds
 * @return {!Promise<!Array<!Result>>} Unadjusted, unsorted results.
 */
async function getMonthConsumption(channels, bounds) {
  const cached = bounds.isComplete ? getCachedMonth(bounds.key) : null;
  if (cached) return cached;

  const results = await Promise.all(channels.map(async (ch) => ({
    id: ch.id,
    name: ch.name,
    consumption: await fetchChannelConsumption(ch, bounds),
  })));

  // Only cache months that are over and fully fetched.
  if (bounds.isComplete && results.every((r) => r.consumption !== null)) {
    setCachedMonth(bounds.key, results);
  }
  return results;
}

/**
 * Applies the household rules and sorts by consumption:
 *  - subtracts sub-meters from the channel that already includes them;
 *  - optionally adds an "Unknown" row for main meter minus everything else.
 *
 * @param {!Array<!Result>} raw
 * @param {!Rules} rules
 * @return {!Array<!Result>} New array, sorted descending; nulls last.
 */
function applyAdjustments(raw, rules) {
  const results = raw.map((r) => ({...r}));
  const byName = (name) => results.find((r) => r.name === name);

  for (const {target, subs} of rules.subtractions) {
    const t = byName(target);
    if (!t || t.consumption === null) continue;
    for (const sub of subs) {
      const item = byName(sub);
      if (item?.consumption != null) t.consumption -= item.consumption;
    }
  }

  const main = rules.mainMeter ? byName(rules.mainMeter) : null;
  if (rules.showUnknown && main && main.consumption !== null) {
    const names = unknownComponents(rules, results.map((r) => r.name));
    const subtracted = results.filter((r) => names.includes(r.name))
                           .reduce((acc, r) => acc + (r.consumption ?? 0), 0);
    const unknown = main.consumption - subtracted;
    results.push({
      id: null,
      name: rules.unknownLabel,
      consumption: rules.unknownClamp ? Math.max(0, unknown) : unknown,
    });
  }

  const key = (r) => r.consumption ?? -Infinity;
  results.sort((a, b) => (key(a) === key(b) ? 0 : key(b) - key(a)));
  return results;
}

/**
 * Channel names subtracted from the main meter to obtain "Unknown".
 * @param {!Rules} rules
 * @param {!Array<string>} available Channel names present in the data.
 * @return {!Array<string>}
 */
function unknownComponents(rules, available) {
  const others = available.filter((n) => n !== rules.mainMeter);
  return rules.unknownMode === 'selected' ?
      others.filter((n) => rules.unknownSubs.includes(n)) :
      others;
}

// ---------------------------------------------------------------------------
// 6. Persistence (month cache + rules)
// ---------------------------------------------------------------------------

/** @return {!Object<string, !Array<!Result>>} */
function loadCache() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE.monthCache) || '{}');
  } catch {
    return {};
  }
}

/**
 * Coerces anything (e.g. parsed JSON) into a well-formed Rules object.
 * @param {*} input
 * @return {!Rules}
 */
function normalizeRules(input) {
  const r = input && typeof input === 'object' ? input : {};
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  const strList = (v) => (Array.isArray(v) ? v : []).map(str).filter(Boolean);
  const mainMeter = str(r.mainMeter) || null;
  const subtractions = Array.isArray(r.subtractions) ? r.subtractions : [];
  return {
    mainMeter,
    showUnknown: r.showUnknown !== false,
    unknownLabel: str(r.unknownLabel) || DEFAULT_RULES.unknownLabel,
    unknownMode: r.unknownMode === 'selected' ? 'selected' : 'all',
    unknownSubs: strList(r.unknownSubs).filter((n) => n !== mainMeter),
    unknownClamp: r.unknownClamp !== false,
    subtractions: subtractions
        .map((s) => ({target: str(s?.target), subs: strList(s?.subs)}))
        .map((s) => ({...s, subs: s.subs.filter((n) => n !== s.target)}))
        .filter((s) => s.target && s.subs.length > 0),
  };
}

/** @return {!Rules} Saved rules, or the defaults. */
function loadRules() {
  const saved = localStorage.getItem(STORAGE.rules);
  if (!saved) return normalizeRules(DEFAULT_RULES);
  try {
    return normalizeRules(JSON.parse(saved));
  } catch {
    return normalizeRules(DEFAULT_RULES);
  }
}

/** @param {!Rules} rules */
function saveRules(rules) {
  localStorage.setItem(STORAGE.rules, JSON.stringify(rules));
}

/**
 * @param {string} key
 * @return {?Array<!Result>}
 */
function getCachedMonth(key) {
  return loadCache()[key] ?? null;
}

/**
 * @param {string} key
 * @param {!Array<!Result>} results
 */
function setCachedMonth(key, results) {
  const cache = loadCache();
  cache[key] = results;
  try {
    localStorage.setItem(STORAGE.monthCache, JSON.stringify(cache));
  } catch (e) {
    console.warn('Could not persist month cache:', e);
  }
}

function clearCache() {
  localStorage.removeItem(STORAGE.monthCache);
}

// ---------------------------------------------------------------------------
// 7. Render
// ---------------------------------------------------------------------------

/**
 * Creates an empty card with a title and a loading placeholder.
 * @param {string} title
 * @return {!HTMLElement}
 */
function createCard(title) {
  const card = document.createElement('div');
  card.className = 'month-stats';
  const h2 = document.createElement('h2');
  h2.textContent = title;
  const loading = document.createElement('p');
  loading.className = 'loading';
  loading.textContent = 'Loading…';
  card.append(h2, loading);
  return card;
}

/** @param {!HTMLElement} card */
function clearCardLoading(card) {
  card.querySelector('.loading')?.remove();
}

/**
 * Fills (or refreshes) a card with the consumption table for one month.
 * @param {!HTMLElement} card
 * @param {!Array<!Result>} results
 */
function renderMonthTable(card, results) {
  clearCardLoading(card);
  card.querySelector('table')?.remove();
  const table = document.createElement('table');
  const thead = table.createTHead();
  const headRow = thead.insertRow();
  for (const text of ['Device', 'kWh']) {
    const th = document.createElement('th');
    th.textContent = text;
    headRow.appendChild(th);
  }

  const tbody = table.createTBody();
  for (const r of results.filter(isSignificant)) {
    const row = tbody.insertRow();
    row.dataset.deviceName = r.name;
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.insertCell().textContent = r.name;
    row.insertCell().textContent = toKwh(r.consumption).toFixed(2);
  }
  // Channels whose fetch failed are left out (details are in the console).
  card.appendChild(table);
}

/**
 * Fills a card with a pie chart for one month, or refreshes its data.
 * @param {!MonthView} view
 */
function renderPieCard(view) {
  if (view.pie) {
    view.pie.results = view.results;
    drawPie(view.pie);
    return;
  }
  const card = view.pieCard;
  const title = view.bounds.title;
  clearCardLoading(card);
  const container = document.createElement('div');
  container.className = 'pie-chart';
  container.tabIndex = 0;
  container.setAttribute('role', 'button');
  container.setAttribute('aria-label', `Maximize chart for ${title}`);
  card.appendChild(container);

  const pie = {container, chart: null, title, results: view.results};
  view.pie = pie;

  const open = () => openChartModal(pie);
  container.addEventListener('click', open);
  container.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      open();
    }
  });

  drawPie(pie);
}

/**
 * Draws (or redraws) a pie chart.
 * @param {!Pie} pie
 * @param {{container: !HTMLElement, chart: ?google.visualization.PieChart}=}
 *     target Where to draw; defaults to the pie's own card.
 * @param {boolean=} maximized
 * @return {!google.visualization.PieChart} The chart instance used.
 */
function drawPie(pie, target = pie, maximized = false) {
  const colors = themeColors();
  const data = new google.visualization.DataTable();
  data.addColumn('string', 'Device');
  data.addColumn('number', 'Consumption (kWh)');
  // Pie charts cannot show negative slices, which a subtraction rule can produce.
  data.addRows(
      pie.results
          .filter((r) => r.name !== state.rules.mainMeter && r.consumption !== null &&
                  r.consumption >= CONFIG.minDisplayWh)
          .map((r) => [r.name, toKwh(r.consumption)]));

  const chart = target.chart ?? new google.visualization.PieChart(target.container);
  target.chart = chart;
  chart.draw(data, {
    title: pie.title,
    backgroundColor: colors.background,
    titleTextStyle: {color: colors.text, fontSize: maximized ? 24 : 14},
    legend: {
      position: 'right',
      textStyle: {color: colors.text, fontSize: maximized ? 16 : 12},
    },
    pieSliceText: 'percentage',
    pieHole: 0.3,
    chartArea: {width: '90%', height: '90%'},
    colors: CHART_COLORS,
  });
  return chart;
}

function redrawAllPies() {
  for (const view of state.months) {
    if (view.pie) drawPie(view.pie);
  }
}

/**
 * @return {!Array<{name: string, color: string}>} Selected devices with the
 *     colour each one uses on the line chart.
 */
function selectedSeries() {
  return [...state.selected].map(
      (name, i) => ({name, color: CHART_COLORS[i % CHART_COLORS.length]}));
}

/** Tints table rows of selected devices with their line-chart colour. */
function updateTableHighlights() {
  const colorByName = new Map(selectedSeries().map((s) => [s.name, s.color]));
  for (const row of dom.tables.querySelectorAll('tr[data-device-name]')) {
    const color = colorByName.get(row.dataset.deviceName);
    row.classList.toggle('selected', color !== undefined);
    row.setAttribute('aria-pressed', String(color !== undefined));
    if (color) {
      row.style.setProperty('--row-color', color);
    } else {
      row.style.removeProperty('--row-color');
    }
  }
}

/**
 * Draws the month-over-month line chart for the selected devices. Incomplete
 * months (i.e. the current one) are projected to month end and drawn dashed.
 */
function drawLineChart() {
  const months = state.months.filter((m) => m.raw !== null);
  const series = selectedSeries();
  if (months.length === 0 || series.length === 0) {
    state.lineChart?.clearChart();
    return;
  }

  const colors = themeColors();
  const data = new google.visualization.DataTable();
  data.addColumn('string', 'Month');
  for (const s of series) {
    data.addColumn('number', `${s.name} (kWh)`);
    data.addColumn({type: 'string', role: 'tooltip'});
    data.addColumn({type: 'boolean', role: 'certainty'});
  }
  data.addRows(months.map((m) => {
    const b = m.bounds;
    const label = b.isComplete ? b.shortLabel : `${b.shortLabel} (est.)`;
    return [
      label,
      ...series.flatMap((s) => {
        const r = m.results.find((x) => x.name === s.name);
        const actual = r?.consumption != null ? r.consumption : 0;
        const value = b.isComplete ? actual : projectToMonthEnd(actual, b);
        const tooltip = b.isComplete ?
            `${s.name}, ${b.shortLabel}: ${toKwh(actual).toFixed(2)} kWh` :
            `${s.name}, ${b.shortLabel}: ~${toKwh(value).toFixed(2)} kWh projected\n` +
                `(${toKwh(actual).toFixed(2)} kWh after ` +
                `${Math.round(b.elapsedFraction * 100)}% of the month)`;
        return [toKwh(value), tooltip, b.isComplete];
      }),
    ];
  }));

  const hasProjection = months.some((m) => !m.bounds.isComplete);
  const titleSuffix = hasProjection ? ' — current month projected to month end' : '';

  state.lineChart ??= new google.visualization.LineChart(dom.lineChart);
  state.lineChart.draw(data, {
    title: `Consumption Comparison: ${series.map((s) => s.name).join(', ')}${titleSuffix}`,
    curveType: 'function',
    legend: {position: 'bottom', textStyle: {color: colors.text}},
    backgroundColor: colors.background,
    colors: series.map((s) => s.color),
    titleTextStyle: {color: colors.text, fontSize: 18},
    hAxis: {
      textStyle: {color: colors.text},
      gridlines: {color: 'transparent'},
      showTextEvery: 1,
    },
    vAxis: {
      textStyle: {color: colors.text},
      gridlines: {color: colors.grid},
      title: 'Consumption (kWh)',
      titleTextStyle: {color: colors.text},
    },
    chartArea: {width: '90%', height: '80%'},
    pointSize: 5,
  });
}

/** Redraws every chart (theme change / resize). */
function redrawAll() {
  drawLineChart();
  redrawAllPies();
  if (state.modalPie) drawModalPie();
}

function drawModalPie() {
  state.modalChart = drawPie(
      state.modalPie, {container: dom.modalChart, chart: state.modalChart}, true);
}

/** @param {!HTMLElement} modal */
function openModal(modal) {
  modal.classList.add('open');
}

/** @param {!HTMLElement} modal */
function closeModal(modal) {
  modal.classList.remove('open');
  if (modal === dom.chartModal) {
    state.modalPie = null;
    state.modalChart?.clearChart();
  }
}

/** @param {!Pie} pie */
function openChartModal(pie) {
  state.modalPie = pie;
  openModal(dom.chartModal);
  drawModalPie();
}

// ---------------------------------------------------------------------------
// 8. Controller
// ---------------------------------------------------------------------------

/** @return {!Set<string>} The device(s) plotted when nothing is selected. */
function defaultSelection() {
  const fallback = state.months.find((m) => m.raw)?.results[0]?.name;
  const name = state.rules.mainMeter ?? fallback;
  return new Set(name ? [name] : []);
}

/**
 * Clears the dashboard and renders every month in the selected range.
 * @param {string} range
 * @return {!Promise<void>}
 */
async function renderRange(range) {
  const token = ++state.renderToken;
  dom.tables.replaceChildren();
  dom.pies.replaceChildren();
  state.months = [];
  state.selected = defaultSelection();
  state.lineChart?.clearChart();

  const channels = listChannels(state.deviceList);
  if (channels.length === 0) {
    showStatus('No compatible energy-metering devices/channels found.', true);
    return;
  }

  const months = monthsInRange(range);
  showStatus(`Fetching ${months.length} months × ${channels.length} channels…`);

  // Create the cards up front so parallel completion cannot reorder them.
  state.months = months.map((bounds) => ({
    bounds,
    tableCard: createCard(`${bounds.title} Consumption`),
    pieCard: createCard(bounds.title),
    raw: null,
    results: [],
    pie: null,
  }));
  dom.tables.append(...state.months.map((m) => m.tableCard));
  dom.pies.append(...state.months.map((m) => m.pieCard));

  await Promise.all(state.months.map(async (view) => {
    const raw = await getMonthConsumption(channels, view.bounds);
    if (token !== state.renderToken) return;  // superseded
    view.raw = raw;
    view.results = applyAdjustments(raw, state.rules);
    renderMonthTable(view.tableCard, view.results);
    renderPieCard(view);
  }));
  if (token !== state.renderToken) return;

  clearStatus();
  drawLineChart();
  updateTableHighlights();
}

/** Re-applies `state.rules` to the already-fetched months (no network). */
function applyRules() {
  for (const view of state.months) {
    if (view.raw === null) continue;
    view.results = applyAdjustments(view.raw, state.rules);
    renderMonthTable(view.tableCard, view.results);
    renderPieCard(view);
  }
  // Drop selections that no longer exist (e.g. a renamed "Unknown" row).
  const names = new Set(state.months.flatMap((m) => m.results.map((r) => r.name)));
  state.selected = new Set([...state.selected].filter((n) => names.has(n)));
  if (state.selected.size === 0) state.selected = defaultSelection();
  drawLineChart();
  updateTableHighlights();
  if (state.modalPie) drawModalPie();
}

/** Re-renders the current range, keeping the controls disabled meanwhile. */
async function loadRange() {
  dom.range.disabled = true;
  dom.refresh.disabled = true;
  try {
    await renderRange(dom.range.value);
  } catch (e) {
    console.error(e);
    showStatus(`Failed to load statistics: ${e.message}`, true);
  } finally {
    dom.range.disabled = false;
    dom.refresh.disabled = false;
  }
}

/** Fetches the device list with the current key, then renders the range. */
async function loadData() {
  if (!state.authKey) {
    showStatus('No Shelly Cloud auth key configured — open Settings to add one.', true);
    openModal(dom.settingsModal);
    return;
  }
  showStatus('Loading device list…');
  try {
    state.deviceList = await fetchDeviceList();
  } catch (e) {
    console.error(e);
    showStatus(`Failed to load device list: ${e.message}`, true);
    return;
  }
  await loadRange();
}

/** @param {string} deviceName */
function toggleSelectedDevice(deviceName) {
  if (state.selected.has(deviceName)) {
    state.selected.delete(deviceName);
    if (state.selected.size === 0) state.selected = defaultSelection();
  } else {
    state.selected.add(deviceName);
  }
  drawLineChart();
  updateTableHighlights();
}

function initTheme() {
  const prefersLight = matchMedia('(prefers-color-scheme: light)').matches;
  dom.theme.value = localStorage.getItem(STORAGE.theme) || (prefersLight ? 'light' : 'dark');
  const apply = () => {
    document.documentElement.setAttribute('data-theme', dom.theme.value);
    localStorage.setItem(STORAGE.theme, dom.theme.value);
    redrawAll();
  };
  dom.theme.addEventListener('change', apply);
  apply();
}

function initModals() {
  const modals = [dom.chartModal, dom.settingsModal, dom.rulesModal];
  for (const modal of modals) {
    modal.querySelector('.close-modal').addEventListener('click', () => closeModal(modal));
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeModal(modal);  // backdrop click
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    for (const modal of modals) {
      if (modal.classList.contains('open')) closeModal(modal);
    }
  });
}

function initSettings() {
  dom.settingsBtn.addEventListener('click', () => {
    dom.apiKeyInput.value = state.authKey;
    openModal(dom.settingsModal);
    dom.apiKeyInput.focus();
  });
  const save = () => {
    state.authKey = dom.apiKeyInput.value.trim();
    if (state.authKey) {
      localStorage.setItem(STORAGE.authKey, state.authKey);
    } else {
      localStorage.removeItem(STORAGE.authKey);
    }
    clearCache();  // results may belong to a different account
    closeModal(dom.settingsModal);
    loadData();
  };
  dom.saveSettings.addEventListener('click', save);
  dom.apiKeyInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') save();
  });
}

// ---- Rules dialog ----

/**
 * Device names offered in the Rules dialog: everything in the device list,
 * plus any names already referenced by the rules (so a saved rule is never
 * silently dropped just because the device list hasn't loaded yet).
 * @param {!Rules} rules
 * @return {!Array<string>} Sorted.
 */
function ruleDeviceNames(rules) {
  const names = new Set(listChannels(state.deviceList).map((c) => c.name));
  if (rules.mainMeter) names.add(rules.mainMeter);
  for (const s of rules.subtractions) {
    names.add(s.target);
    for (const n of s.subs) names.add(n);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

/**
 * Replaces a <select>'s options.
 * @param {!HTMLSelectElement} select
 * @param {!Array<string>} names
 * @param {?string} value
 * @param {string=} emptyLabel Label for an extra empty option, if wanted.
 */
function fillSelect(select, names, value, emptyLabel) {
  select.replaceChildren();
  if (emptyLabel !== undefined) select.add(new Option(emptyLabel, ''));
  for (const n of names) select.add(new Option(n, n));
  select.value = value ?? '';
}

/**
 * Builds one "target minus [subs]" row from the template.
 * @param {{target: string, subs: !Array<string>}} rule
 * @param {!Array<string>} names
 * @return {!HTMLElement}
 */
function createSubtractionRow(rule, names) {
  const row = /** @type {!HTMLElement} */ (
      dom.ruleRowTemplate.content.firstElementChild.cloneNode(true));
  const target = /** @type {!HTMLSelectElement} */ (row.querySelector('.rule-target'));
  const subsBox = row.querySelector('.rule-subs');
  fillSelect(target, names, rule.target, '— choose —');

  const renderSubs = () => {
    const checked = new Set(
        [...subsBox.querySelectorAll('input:checked')].map((i) => i.value));
    if (checked.size === 0) rule.subs.forEach((s) => checked.add(s));
    subsBox.replaceChildren();
    for (const n of names) {
      if (n === target.value) continue;  // can't subtract a channel from itself
      const label = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = n;
      cb.checked = checked.has(n);
      label.append(cb, ` ${n}`);
      subsBox.appendChild(label);
    }
  };
  target.addEventListener('change', renderSubs);
  row.querySelector('.rule-remove').addEventListener('click', () => row.remove());
  renderSubs();
  return row;
}

/**
 * Re-renders the "subtract only these channels" checklist for Unknown,
 * excluding the currently selected main meter.
 * @param {!Array<string>} names All device names.
 * @param {!Array<string>} checked Names that should start checked.
 */
function renderUnknownSubs(names, checked) {
  const keep = new Set(checked);
  dom.ruleUnknownSubs.replaceChildren();
  for (const n of names) {
    if (n === dom.ruleMainMeter.value) continue;
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = n;
    cb.checked = keep.has(n);
    label.append(cb, ` ${n}`);
    dom.ruleUnknownSubs.appendChild(label);
  }
}

/** @return {string} The Unknown radio currently selected ('all'|'selected'). */
function unknownModeFromForm() {
  const checked = dom.rulesModal.querySelector('input[name="rule-unknown-mode"]:checked');
  return checked ? checked.value : 'all';
}

/** Syncs enabled/disabled state and the formula preview with the form. */
function refreshUnknownSection() {
  const show = dom.ruleShowUnknown.checked;
  dom.ruleUnknownOptions.disabled = !show;
  const selectedMode = unknownModeFromForm() === 'selected';
  dom.ruleUnknownSubs.classList.toggle('is-hidden', !selectedMode);

  const main = dom.ruleMainMeter.value;
  const label = dom.ruleUnknownLabel.value.trim() || DEFAULT_RULES.unknownLabel;
  let text;
  if (!show) {
    text = 'The "Unknown" row is hidden.';
  } else if (!main) {
    text = 'Choose a main meter to compute the "Unknown" row.';
  } else {
    const terms = selectedMode ?
        [...dom.ruleUnknownSubs.querySelectorAll('input:checked')].map((i) => i.value) :
        ['every other channel'];
    const sum = terms.length ? terms.join(' + ') : 'nothing';
    const clamp = dom.ruleUnknownClamp.checked ? ', never below 0' : '';
    text = `${label} = ${main} − (${sum})${clamp}`;
  }
  dom.ruleUnknownFormula.textContent = text;
}

/** @param {!Rules} rules */
function fillRulesForm(rules) {
  const names = ruleDeviceNames(rules);
  fillSelect(dom.ruleMainMeter, names, rules.mainMeter, '— none —');
  dom.ruleShowUnknown.checked = rules.showUnknown;
  dom.ruleUnknownLabel.value = rules.unknownLabel;
  dom.rulesModal.querySelector(
      `input[name="rule-unknown-mode"][value="${rules.unknownMode}"]`).checked = true;
  dom.ruleUnknownClamp.checked = rules.unknownClamp;
  renderUnknownSubs(names, rules.unknownSubs);
  dom.ruleSubtractions.replaceChildren(
      ...rules.subtractions.map((s) => createSubtractionRow(s, names)));
  refreshUnknownSection();
}

/** @return {!Rules} */
function readRulesForm() {
  const subtractions = [...dom.ruleSubtractions.querySelectorAll('.rule-row')].map((row) => ({
    target: /** @type {!HTMLSelectElement} */ (row.querySelector('.rule-target')).value,
    subs: [...row.querySelectorAll('.rule-subs input:checked')].map((i) => i.value),
  }));
  return normalizeRules({
    mainMeter: dom.ruleMainMeter.value,
    showUnknown: dom.ruleShowUnknown.checked,
    unknownLabel: dom.ruleUnknownLabel.value,
    unknownMode: unknownModeFromForm(),
    unknownSubs: [...dom.ruleUnknownSubs.querySelectorAll('input:checked')].map((i) => i.value),
    unknownClamp: dom.ruleUnknownClamp.checked,
    subtractions,
  });
}

function initRules() {
  dom.rulesBtn.addEventListener('click', () => {
    fillRulesForm(state.rules);
    openModal(dom.rulesModal);
  });
  // Changing the main meter changes which channels can be subtracted.
  dom.ruleMainMeter.addEventListener('change', () => {
    const current = readRulesForm();
    renderUnknownSubs(ruleDeviceNames(current), current.unknownSubs);
    refreshUnknownSection();
  });
  // Any other change in the Unknown section just refreshes the preview.
  dom.rulesModal.querySelector('.rules-section--unknown')
      .addEventListener('input', refreshUnknownSection);
  dom.ruleAddSubtraction.addEventListener('click', () => {
    const names = ruleDeviceNames(readRulesForm());
    const row = createSubtractionRow({target: '', subs: []}, names);
    dom.ruleSubtractions.appendChild(row);
    row.querySelector('.rule-target').focus();
  });
  dom.resetRules.addEventListener('click', () => fillRulesForm(normalizeRules(DEFAULT_RULES)));
  dom.saveRules.addEventListener('click', () => {
    state.rules = readRulesForm();
    saveRules(state.rules);
    closeModal(dom.rulesModal);
    applyRules();
  });
}

function initTableInteraction() {
  const rowOf = (e) => e.target.closest('tr[data-device-name]');
  dom.tables.addEventListener('click', (e) => {
    const row = rowOf(e);
    if (row) toggleSelectedDevice(row.dataset.deviceName);
  });
  dom.tables.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const row = rowOf(e);
    if (!row) return;
    e.preventDefault();
    toggleSelectedDevice(row.dataset.deviceName);
  });
}

async function init() {
  await new Promise((resolve) => {
    google.charts.load('current', {packages: ['corechart']});
    google.charts.setOnLoadCallback(resolve);
  });

  initTheme();
  initModals();
  initSettings();
  initRules();
  initTableInteraction();
  dom.range.addEventListener('change', loadRange);
  dom.refresh.addEventListener('click', () => {
    clearCache();
    loadRange();
  });
  window.addEventListener('resize', debounce(redrawAll, 150));

  await loadData();
}

init();
