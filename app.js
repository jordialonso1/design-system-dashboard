const THEME_KEY = "dsh-theme";
const HIDE_MERGED_BRANCHES_KEY = "dsh-hide-merged-branches";
const EXCLUDE_CYCLE_TIME_CLEANUP_KEY = "dsh-exclude-cycle-time-cleanup";
const BRANCHES_PER_PAGE_KEY = "dsh-branches-per-page";
const BRANCHES_PER_PAGE_OPTIONS = [20, 50, 200];
const WIDGET_INDEX_COLLAPSED_KEY = "dsh-widget-index-collapsed";
const BRANCH_CATEGORY_FILTER_KEY = "dsh-branch-category-filter";
const BRANCH_CATEGORIES_DRAFT_KEY = "dsh-branch-categories-draft";
let charts = [];
let cachedHistory = null;
// The committed baseline from data/branch-categories.json (see CLAUDE.md —
// it lives on metrics-data like history.jsonl/latest.json, published by
// hand rather than by the collector). branchCategoriesDraft holds this
// session's own pending edits on top of it (see loadBranchCategoriesDraft),
// since the dashboard has no write path back to metrics-data itself.
let branchCategories = {};
let branchCategoriesDraft = {};
// 'all' | 'pintxo' | 'business' — scoped to the Branches tab only (Branch
// activity, Cycle time trend, Library branches); Overview has no per-branch
// attribution for its own tiles, so it's never filtered by this.
let activeBranchCategory = "all";
let branchActivityChart = null;
let cycleTimeScatterChart = null;
let agingHistoryChart = null;
let branchActivityGranularity = "week";
// Windows back from "now" — 0 is the current window, 1 is one window-length
// further back, etc. Each granularity pages by its own window length (14
// days / 8 weeks / 6 months), reset to 0 whenever the granularity changes.
let branchActivityOffset = 0;
// Same "windows back from now" convention as branchActivityOffset, but for
// the Cycle Time Scatter Plot's fixed 90-day window.
let cycleTimeOffset = 0;
// Whether detected "cleanup event" branches (see detectCleanupEvents in
// cycle-time-math.js) are excluded from the Cycle Time Scatter Plot's
// metrics (P50/P85, rolling curve, trendline, KPI baseline, monthly
// table). The dots themselves stay visible either way — only the numbers
// computed around them change.
let cycleTimeExcludeCleanup = false;
let branchesPerPage = BRANCHES_PER_PAGE_OPTIONS[0];
let branchesPage = 0;

// history.jsonl is append-only, but appends aren't always chronological —
// a historical-backfill commit appends its (old) snapshot after whatever
// the live hourly collector last wrote, so the *file's* last line can be
// older than earlier lines. Every other function here assumes `history` is
// time-ordered (history.at(-1) is "the latest snapshot", etc.), so that
// ordering is established once, right here, rather than trusted from the
// file — sort by timestamp ascending immediately after parsing.
async function loadHistory() {
  const res = await fetch("data/history.jsonl", { cache: "no-store" });
  const text = await res.text();
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
}

// data/branch-categories.json is a hand-maintained { [branchKey]: 'pintxo' |
// 'business' } map (see CLAUDE.md's Branches tab section) — absent, a 404,
// or a parse failure are all treated as "nothing tagged yet" rather than an
// error, same tolerance as the rest of this page's data loading.
async function loadBranchCategories() {
  try {
    const res = await fetch("data/branch-categories.json", { cache: "no-store" });
    if (!res.ok) return {};
    const data = await res.json();
    return data && typeof data === "object" ? data : {};
  } catch (e) {
    return {};
  }
}

function loadBranchCategoriesDraft() {
  try {
    const stored = JSON.parse(localStorage.getItem(BRANCH_CATEGORIES_DRAFT_KEY));
    return stored && typeof stored === "object" ? stored : {};
  } catch (e) {
    return {};
  }
}

function saveBranchCategoriesDraft() {
  try {
    localStorage.setItem(BRANCH_CATEGORIES_DRAFT_KEY, JSON.stringify(branchCategoriesDraft));
  } catch (e) {
    // Private browsing / storage disabled — the draft just won't persist.
  }
}

// A branch's effective category: this session's own pending edit (if any —
// including an explicit "cleared back to unassigned", stored as `null` so it
// doesn't fall through to a since-superseded committed value) over the
// committed baseline.
function getBranchCategory(key) {
  if (Object.prototype.hasOwnProperty.call(branchCategoriesDraft, key)) {
    return branchCategoriesDraft[key];
  }
  return branchCategories[key] ?? null;
}

function setBranchCategoryDraft(key, category) {
  branchCategoriesDraft[key] = category;
  saveBranchCategoriesDraft();
}

function branchMatchesCategory(key, category) {
  return category === "all" || getBranchCategory(key) === category;
}

function fmtDate(iso) {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

// Short "MMM d" labels for chart x-axes — a full date+time string like
// "Mar 18, 2026, 11:54 AM" is too wide to lay out without overlap once a
// chart is squeezed into a two-column panel (see the Branch activity
// chart's bucket labels, which already use this shorter form).
function fmtChartLabel(iso) {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// ISO-8601 week number (weeks start Monday, week 1 contains the year's
// first Thursday) — matches the "W23" convention used on the Branch
// activity chart's week-granularity axis labels.
function isoWeekNumber(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
}

function delta(current, previous) {
  // Deliberately not color-coded green/red: whether "up" is good or bad
  // depends on the metric (more resolved issues is good, more open issues
  // usually isn't), so this just states the change and lets the reader judge.
  if (previous == null || typeof current !== "number") return null;
  const diff = Math.round((current - previous) * 10) / 10;
  if (diff === 0) return { text: "No change vs. previous snapshot" };
  const sign = diff > 0 ? "+" : "";
  const glyph = diff > 0 ? "▲" : "▼";
  return { text: `${glyph} ${sign}${diff} vs. previous snapshot` };
}

function renderTiles(history) {
  const latest = history.at(-1);
  const prev = history.at(-2);
  const tiles = document.getElementById("tiles");

  const figmaComponents = latest.figma?.[0]?.componentCount ?? "—";
  const prevFigmaComponents = prev?.figma?.[0]?.componentCount;

  const openIssues = latest.jira?.openCount ?? "—";
  const prevOpenIssues = prev?.jira?.openCount;

  const meetingHours = latest.calendar?.meetingHoursLast7Days ?? "—";
  const prevMeetingHours = prev?.calendar?.meetingHoursLast7Days;

  const items = [
    { accent: "figma", label: "Published components", value: figmaComponents, delta: delta(figmaComponents, prevFigmaComponents) },
    { accent: "jira", label: "Open Jira issues", value: openIssues, delta: delta(openIssues, prevOpenIssues) },
    { accent: "calendar", label: "Meeting hours (7d)", value: meetingHours, delta: delta(meetingHours, prevMeetingHours) },
  ];

  tiles.innerHTML = items
    .map(
      (item) => `
      <div class="tile" data-accent="${item.accent}">
        <p class="tile-label"><span class="dot" aria-hidden="true"></span>${item.label}</p>
        <p class="kpi-value">${item.value}</p>
        ${item.delta ? `<p class="kpi-delta">${item.delta.text}</p>` : ""}
      </div>`
    )
    .join("");
}

function setValueText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = typeof value === "number" ? value.toLocaleString() : "—";
}

function getCssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function withAlpha(hex, alpha) {
  const n = parseInt(hex.replace("#", ""), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// Highlights only the latest point on a line (an "end-dot"); every other
// point stays invisible so the line itself carries the story.
function endDotRadii(count) {
  return Array.from({ length: count }, (_, i) => (i === count - 1 ? 4 : 0));
}

function singleChart(canvasId, labels, data, color) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const muted = getCssVar("--ink-muted");
  const gridline = getCssVar("--gridline");
  const surface = getCssVar("--surface");

  const chart = new Chart(canvas, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          data,
          borderColor: color,
          backgroundColor: withAlpha(color, 0.1),
          fill: true,
          borderWidth: 2,
          borderCapStyle: "round",
          borderJoinStyle: "round",
          tension: 0.25,
          pointRadius: endDotRadii(data.length),
          pointBackgroundColor: color,
          pointBorderColor: surface,
          pointBorderWidth: 2,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: surface,
          borderColor: getCssVar("--border"),
          borderWidth: 1,
          titleColor: muted,
          bodyColor: getCssVar("--ink"),
          padding: 10,
          boxPadding: 4,
          cornerRadius: 8,
        },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { color: muted, font: { size: 10 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 5 },
        },
        y: {
          // Auto-scaled to the visible range (not forced to zero) — a metric
          // like "published components" sits in the thousands with tiny
          // day-to-day moves, and a zero baseline flattens all of it away.
          grid: { color: gridline, drawTicks: false },
          border: { display: false },
          ticks: {
            color: muted,
            font: { size: 10 },
            maxTicksLimit: 4,
            callback: (value) => Number(value).toLocaleString(),
          },
        },
      },
    },
  });

  charts.push(chart);
}

function renderCharts(history) {
  charts.forEach((c) => c.destroy());
  charts = [];

  const labels = history.map((h) => fmtChartLabel(h.timestamp));
  const accentFigma = getCssVar("--accent-figma");
  const accentJira = getCssVar("--accent-jira");
  const accentCalendar = getCssVar("--accent-calendar");

  const figmaComponents = history.map((h) => h.figma?.[0]?.componentCount ?? null);
  const figmaStyles = history.map((h) => h.figma?.[0]?.styleCount ?? null);
  // Only present from the snapshot componentCount stopped counting every
  // icon glyph/payment icon as its own "component" onward — older snapshots
  // fall back to null, which singleChart already renders as a gap.
  const figmaIconAssets = history.map((h) => h.figma?.[0]?.iconAssetCount ?? null);
  const jiraOpen = history.map((h) => h.jira?.openCount ?? null);
  const jiraResolved = history.map((h) => h.jira?.resolvedThisWeek ?? null);
  const meetingHours = history.map((h) => h.calendar?.meetingHoursLast7Days ?? null);

  setValueText("value-figma-components", figmaComponents.at(-1));
  setValueText("value-figma-styles", figmaStyles.at(-1));
  setValueText("value-figma-icon-assets", figmaIconAssets.at(-1));
  setValueText("value-jira-open", jiraOpen.at(-1));
  setValueText("value-jira-resolved", jiraResolved.at(-1));

  singleChart("chart-figma-components", labels, figmaComponents, accentFigma);
  singleChart("chart-figma-styles", labels, figmaStyles, accentFigma);
  singleChart("chart-figma-icon-assets", labels, figmaIconAssets, accentFigma);
  singleChart("chart-jira-open", labels, jiraOpen, accentJira);
  singleChart("chart-jira-resolved", labels, jiraResolved, accentJira);
  singleChart("chart-calendar", labels, meetingHours, accentCalendar);
}

function startOfDay(value) {
  const d = new Date(value);
  d.setHours(0, 0, 0, 0);
  return d;
}

// Folds every snapshot's branch list into one record per branch key, so a
// branch that has since merged/archived (and dropped out of the latest
// snapshot) is still represented — with the most recent name/handles/dates
// seen for it and the timestamp of the last snapshot it still appeared in.
function computeBranchRecords(history) {
  const byKey = new Map();

  for (const snapshot of history) {
    const branches = Array.isArray(snapshot.figma) ? snapshot.figma[0]?.branches ?? [] : [];
    for (const branch of branches) {
      const record = byKey.get(branch.key) ?? { key: branch.key, createdAt: null };
      record.name = branch.name ?? record.name;
      record.createdByHandle = branch.createdByHandle ?? record.createdByHandle;
      record.lastEditedByHandle = branch.lastEditedByHandle ?? record.lastEditedByHandle;
      record.createdAt = record.createdAt ?? branch.createdAt ?? null;
      record.lastEditedAt = branch.lastEditedAt ?? branch.lastModified ?? record.lastEditedAt;
      record.lastSeenAt = snapshot.timestamp;
      byKey.set(branch.key, record);
    }
  }

  return byKey;
}

// The set of currently-open branch keys, from the latest snapshot's Figma
// section — or `null` if that snapshot's Figma collection failed. Every
// consumer below used to re-derive this inline, and two of them (
// computeBranchLifecycles, computeCycleTimeDataset) forgot the failure
// check the other three already had — on a failed collector run they'd
// silently compute an empty Set instead of bailing, which would make every
// branch this dashboard has ever seen look merged/archived (since none of
// them would be "in" the empty open set). Centralizing this here means
// there's only one place to get that guard right.
function getLatestOpenKeys(latest) {
  const figma = latest.figma;
  if (!figma || figma.error) return null;
  return new Set((Array.isArray(figma) ? figma[0]?.branches ?? [] : []).map((b) => b.key));
}

// Every branch we've ever seen contributes at most one "created" event (at
// its true createdAt, once resolved) and, if it's no longer in the latest
// snapshot, one "merged/archived" event — attributed to the last snapshot
// timestamp it still appeared in, since we only sample hourly and can't see
// the exact moment it left. history.jsonl is append-only, so this looks
// across every snapshot ever taken, not just the latest.
//
// Each event carries the branch's own name/author alongside its timestamp
// (not just the bare date) so the Branch activity chart's click-to-expand
// panel (see renderBranchActivityDetails) can list the actual branches
// behind a bucket, the same way the other charts' hover tooltips do. Both
// events attribute to the branch's creator — not whoever last edited it —
// since "who owns this branch" is the more useful signal for a merged/
// archived branch too, and matches how the Cycle Time Scatter Plot and
// Aging Buckets waffle already attribute their branches. Merged events
// before CYCLE_TIME_MIN_CLOSE_DATE (defined below, next to
// computeCycleTimeDataset) are excluded for the same reason that function
// excludes them: before that boundary, lastSeenAt is at best a rough,
// uncorrected backfill estimate, not a real event instant — a concern
// about `lastSeenAt` itself, not specific to the Cycle Time chart, so it
// applies equally here. `category` ('all' | 'pintxo' | 'business') restricts
// this to branches manually tagged that way (see getBranchCategory) — used
// by the Branch activity chart's category filter; every other caller leaves
// it at the default 'all'.
function computeBranchLifecycles(history, category = "all") {
  const openKeys = getLatestOpenKeys(history.at(-1));
  if (!openKeys) return { createdEvents: [], mergedEvents: [] };

  const byKey = computeBranchRecords(history);

  const createdEvents = [];
  const mergedEvents = [];
  for (const [key, info] of byKey) {
    if (!branchMatchesCategory(key, category)) continue;
    if (info.createdAt) {
      createdEvents.push({
        timestamp: info.createdAt,
        key,
        name: info.name ?? key,
        authorHandle: info.createdByHandle,
      });
    }
    if (!openKeys.has(key) && info.lastSeenAt >= CYCLE_TIME_MIN_CLOSE_DATE) {
      mergedEvents.push({
        timestamp: info.lastSeenAt,
        key,
        name: info.name ?? key,
        authorHandle: info.createdByHandle,
      });
    }
  }

  return { createdEvents, mergedEvents };
}

// Adapts computeBranchRecords into the { branchId, name, createdDate,
// closedDate, durationDays, authorHandle } shape createCycleTimeScatterPlot
// (cycle-time-scatter.js) expects — one entry per *closed* branch.
// Still-open branches are excluded: they don't have a finished cycle
// time to plot yet.
// Branches whose *close* event (closedDate/lastSeenAt) falls before this
// date are excluded — this is the boundary of what the historical-backfill
// campaign actually scanned and looked up via Figma's real API (see
// CLAUDE.md's historical-backfill section: "covering everything down
// through the '8 months ago' bucket... merges back through ~January
// 2026"). Live hourly collection only started 2026-09-08, so in practice
// almost every close before that date comes from the backfill regardless
// of the branch's creation date — a branch merged earlier than this
// boundary either isn't in history.jsonl at all, or is from an
// older/unscanned bucket whose merge-event timestamp is at best a rough,
// uncorrected month-bucket estimate (see CLAUDE.md's "A branch's
// merge-event timestamp is only as good as its last edit" — some branches
// sat dormant for a year or more before actually merging). Deliberately
// keyed on *close* date, not creation date: a branch's creation date says
// nothing about which backfill bucket its merge event landed in (plenty of
// branches created in 2025 were backfilled with precise 2026 merge data —
// excluding them by creation date would just be discarding good data for
// no reason). Excluded from the scatter plot and monthly table entirely
// rather than just out-of-window, since the monthly table intentionally
// shows full history. Contrast with CREATOR_STATS_MIN_CREATED_DATE below,
// a separate, deliberately creation-date-keyed cutoff for a different
// purpose.
const CYCLE_TIME_MIN_CLOSE_DATE = "2026-01-01T00:00:00.000Z";

// `category` ('all' | 'pintxo' | 'business') restricts the dataset to
// branches manually tagged that way (see getBranchCategory) — passed by the
// Cycle Time Scatter Plot's own category filter, and also by the Aging
// Buckets/History panels' P50/P85 baseline calls so their SLA yardstick
// stays scoped to whatever category is currently selected.
function computeCycleTimeDataset(history, category = "all") {
  const openKeys = getLatestOpenKeys(history.at(-1));
  if (!openKeys) return [];

  const byKey = computeBranchRecords(history);

  const dataset = [];
  for (const [key, info] of byKey) {
    if (!branchMatchesCategory(key, category)) continue;
    if (openKeys.has(key) || !info.createdAt || !info.lastSeenAt) continue;
    if (info.lastSeenAt < CYCLE_TIME_MIN_CLOSE_DATE) continue;
    const durationDays = (new Date(info.lastSeenAt) - new Date(info.createdAt)) / 86400000;
    // Not just `< 0`: an unparseable createdAt/lastSeenAt yields NaN here,
    // and `NaN < 0` is false — the record would silently pass through with
    // a NaN duration instead of being excluded, corrupting downstream sorts
    // and percentiles (NaN's position in a sort is unspecified).
    if (!(durationDays >= 0)) continue;
    dataset.push({
      branchId: key,
      name: info.name ?? key,
      createdDate: info.createdAt,
      closedDate: info.lastSeenAt,
      durationDays,
      authorHandle: info.createdByHandle,
    });
  }

  return dataset;
}

const CYCLE_TIME_WINDOW_DAYS = 90;

// The [start, end) bounds of the Nth 90-day window back from `now` — offset
// 0 is the current window, 1 is the 90 days immediately before that, etc.
// Same "windows back from now" convention as branchActivityAnchor.
function cycleTimeWindowBounds(offset, now = new Date()) {
  const windowMs = CYCLE_TIME_WINDOW_DAYS * 86400000;
  const end = new Date(now.getTime() - offset * windowMs);
  const start = new Date(end.getTime() - windowMs);
  return { start, end };
}

function fmtCycleTimeRangeLabel(start, end) {
  const fmt = (d) => d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${fmt(start)} – ${fmt(end)}`;
}

// Cycle Time Scatter Plot — one dot per closed branch, with the KPI card,
// rolling P50/P85, outlier highlighting, and trendline layers implemented in
// cycle-time-scatter.js/cycle-time-math.js. Shows a fixed 90-day window
// (paged via cycleTimeOffset) rather than full history, so the scatter and
// its overlays stay legible instead of compressing months of data into one
// view. Left empty (no chart, no KPI tiles) if the window has no
// closed-branch data, same as renderBranches' empty-state check.
function renderCycleTimeScatterChart(history) {
  if (cycleTimeScatterChart) {
    cycleTimeScatterChart.destroy();
    cycleTimeScatterChart = null;
  }

  const canvas = document.getElementById("chart-cycle-time-scatter");
  const legendEl = document.getElementById("cycle-time-metric-legend");
  const kpiEl = document.getElementById("cycle-time-kpi");
  const calloutEl = document.getElementById("cycle-time-cleanup-banner");
  if (!canvas) return;

  const { start, end } = cycleTimeWindowBounds(cycleTimeOffset);
  document.getElementById("cycle-time-range").textContent = fmtCycleTimeRangeLabel(start, end);
  document.getElementById("cycle-time-next").disabled = cycleTimeOffset === 0;

  const fullDataset = computeCycleTimeDataset(history, activeBranchCategory);

  // Detected once, against the full un-windowed history and its own
  // overall P85 — see detectCleanupEvents in cycle-time-math.js. Doing
  // this against `fullDataset` rather than whatever 90-day window happens
  // to be showing keeps a bulk-close cluster in one piece even if it
  // straddles a window boundary, and keeps the monthly table (which is
  // never windowed) consistent with the scatter plot about which branches
  // count as cleanup.
  const cleanupEvents = detectCleanupEvents(fullDataset, { p85: computeCycleTimeSummary(fullDataset).p85 });
  const cleanupKeys = cleanupBranchKeySet(cleanupEvents);
  const withoutCleanup = (arr) => arr.filter((b) => !cleanupKeys.has(b.branchId));

  // The monthly table is deliberately NOT scoped to the 90-day window —
  // it's the one place meant to show the whole history at a glance, which
  // is the opposite of what the window exists for. Render it from the
  // full dataset regardless of whether the current window has any data.
  // Honors the "exclude cleanup outliers" toggle the same way the scatter
  // plot's own metrics do, so the two views never disagree.
  renderCycleTimeMonthlyTable(
    document.getElementById("cycle-time-monthly-table"),
    computeMonthlyCycleTimeStats(cycleTimeExcludeCleanup ? withoutCleanup(fullDataset) : fullDataset)
  );

  const inRange = (b, rangeStartMs) => {
    const closedAtMs = new Date(b.closedDate).getTime();
    return closedAtMs > rangeStartMs && closedAtMs <= end.getTime();
  };

  const dataset = fullDataset.filter((b) => inRange(b, start.getTime()));

  if (dataset.length === 0) {
    legendEl.innerHTML = "";
    kpiEl.innerHTML = `<p class="branch-empty">No closed branches in this window.</p>`;
    if (calloutEl) calloutEl.innerHTML = "";
    return;
  }

  // The rolling P50/P85 curve is a 30-day *trailing* stat — its first ~30
  // days inside the window would otherwise only see whatever partial
  // history happens to fall after `start`, understating its true trailing
  // window purely because of where the window boundary lands, not because
  // that data doesn't exist. Give it an extra 30 days of lookback so every
  // plotted sample gets a full trailing window, while every other metric
  // (P50/P85 summary, trendline, outlier threshold) still comes from
  // `dataset` — strictly the visible window. The KPI card's baseline
  // comparison is the one exception: it needs `fullDataset` (passed as
  // `baselineBranches` below), since a 90-day window can't reliably
  // supply a full trailing 3-month baseline on its own.
  const rollingLookbackMs = 30 * 86400000;
  const rollingBranches = fullDataset.filter((b) => inRange(b, start.getTime() - rollingLookbackMs));

  // Cleanup events that overlap the *visible* window — the ones the
  // callout banner and axis bands should actually talk about, as opposed
  // to every cleanup event ever detected across all of history.
  const windowCleanupEvents = cleanupEvents.filter(
    (event) => new Date(event.endDate).getTime() > start.getTime() && new Date(event.startDate).getTime() <= end.getTime()
  );

  cycleTimeScatterChart = createCycleTimeScatterPlot({
    canvas,
    legendEl,
    kpiEl,
    calloutEl,
    // `branches` (the dots drawn) is always the unfiltered window, so a
    // cleanup spike stays visible on the chart even while excluded below.
    branches: dataset,
    metricsBranches: cycleTimeExcludeCleanup ? withoutCleanup(dataset) : dataset,
    rollingBranches: cycleTimeExcludeCleanup ? withoutCleanup(rollingBranches) : rollingBranches,
    baselineBranches: cycleTimeExcludeCleanup ? withoutCleanup(fullDataset) : fullDataset,
    cleanupEvents: windowCleanupEvents,
    excludingCleanup: cycleTimeExcludeCleanup,
    windowStart: start,
    now: end,
  });
}

function initCycleTimeNav() {
  document.getElementById("cycle-time-prev").addEventListener("click", () => {
    cycleTimeOffset += 1;
    if (cachedHistory) renderCycleTimeScatterChart(cachedHistory);
  });
  document.getElementById("cycle-time-next").addEventListener("click", () => {
    if (cycleTimeOffset === 0) return;
    cycleTimeOffset -= 1;
    if (cachedHistory) renderCycleTimeScatterChart(cachedHistory);
  });
}

function initCycleTimeCleanupToggle() {
  const checkbox = document.getElementById("cycle-time-exclude-cleanup");
  if (!checkbox) return;

  let excludeCleanup = false;
  try {
    excludeCleanup = localStorage.getItem(EXCLUDE_CYCLE_TIME_CLEANUP_KEY) === "true";
  } catch (e) {
    // Private browsing / storage disabled — the toggle just won't persist.
  }
  cycleTimeExcludeCleanup = excludeCleanup;
  checkbox.checked = excludeCleanup;

  checkbox.addEventListener("change", () => {
    cycleTimeExcludeCleanup = checkbox.checked;
    try {
      localStorage.setItem(EXCLUDE_CYCLE_TIME_CLEANUP_KEY, String(checkbox.checked));
    } catch (e) {
      // Private browsing / storage disabled — the toggle just won't persist.
    }
    if (cachedHistory) renderCycleTimeScatterChart(cachedHistory);
  });
}

// Adapts computeBranchRecords into the { branchId, name, ageInDays,
// createdDate, authorHandle }[] shape renderAgingBucketsWaffle
// (aging-buckets-waffle.js) expects — one entry per currently-*open* branch
// (the mirror image of computeCycleTimeDataset, which is closed branches
// only). createdDate/authorHandle aren't needed for the bucketing math
// itself, only for the waffle's per-branch hover tooltip (mirroring the
// Cycle time trend scatter plot's own tooltip) and its "Open in Figma"
// link. A branch with no resolvable createdAt is left out rather than
// guessed at; `excludedCount` (branches dropped for exactly that reason) is
// returned alongside the ages so the panel's KPI header can surface it —
// this is the only place that knows which branches got excluded, since
// aging-buckets-math.js only ever sees the already-filtered `ages` array.
// `category` ('all' | 'pintxo' | 'business') restricts this to branches
// manually tagged that way (see getBranchCategory) — a branch skipped this
// way isn't counted in `excludedCount`, which means something narrower
// ("no resolvable creation date"), not "filtered out by category".
function computeOpenBranchAges(history, category = "all") {
  const openKeys = getLatestOpenKeys(history.at(-1));
  if (!openKeys) return { ages: [], excludedCount: 0 };

  const records = computeBranchRecords(history);
  const now = Date.now();

  const ages = [];
  let excludedCount = 0;
  for (const key of openKeys) {
    if (!branchMatchesCategory(key, category)) continue;
    const record = records.get(key);
    const ageInDays = record?.createdAt ? (now - new Date(record.createdAt).getTime()) / 86400000 : null;
    // Not just `< 0`: an unparseable createdAt yields NaN, and `NaN < 0` is
    // false — it would otherwise slip through uncounted and later sort into
    // the dashboard's most severe ("critical") aging bucket by default.
    if (ageInDays == null || !(ageInDays >= 0)) {
      excludedCount++;
      continue;
    }
    ages.push({
      branchId: key,
      name: record.name ?? key,
      ageInDays,
      createdDate: record.createdAt,
      authorHandle: record.createdByHandle,
    });
  }

  return { ages, excludedCount };
}

// Branches created before this date are excluded from creator attribution
// entirely — unlike CYCLE_TIME_MIN_CLOSE_DATE above (which cares about
// *merge*-timestamp precision), this is deliberately keyed on *creation*
// date: a backfilled branch's creator/creation data is precise regardless
// of its merge date, but crediting someone for a branch they created back
// in the pre-2026 backfill era wouldn't reflect actual recent activity.
const CREATOR_STATS_MIN_CREATED_DATE = "2026-01-01T00:00:00.000Z";

// Adapts computeBranchRecords into the { key, name, authorHandle,
// createdAt }[] shape renderBranchCreatorsTreemap (branch-creators-treemap.js)
// expects — every branch that's since merged/archived (i.e. dropped out of
// the latest snapshot), the same "closed" definition renderBranches/
// computeCycleTimeDataset already use elsewhere on this page. Still-open
// branches are excluded: they're already covered by the Aging Buckets
// waffle, and mixing them in here would count someone's still-in-progress
// work as if it were a finished contribution. Also excludes anything
// created before CREATOR_STATS_MIN_CREATED_DATE (see that constant's
// comment, just above) so pre-2026 backfilled branches don't get credited
// as if they were recent activity. A branch with no resolvable createdAt at
// all is still counted (the creator/count grouping doesn't need it, and it
// can't be "before 2026" either way), unlike computeOpenBranchAges above.
// `category` ('all' | 'pintxo' | 'business') restricts this to branches
// manually tagged that way (see getBranchCategory).
function computeClosedBranchesForCreators(history, category = "all") {
  const openKeys = getLatestOpenKeys(history.at(-1));
  if (!openKeys) return [];

  const records = computeBranchRecords(history);

  return [...records.values()]
    .filter((record) => branchMatchesCategory(record.key, category))
    .filter((record) => !openKeys.has(record.key))
    .filter((record) => !record.createdAt || record.createdAt >= CREATOR_STATS_MIN_CREATED_DATE)
    .map((record) => ({
      key: record.key,
      name: record.name ?? record.key,
      authorHandle: record.createdByHandle,
      createdAt: record.createdAt,
    }));
}

// Branch creators panel — every closed branch, grouped by creator into a
// squarified treemap (layout in branch-creators-math.js, rendering in
// branch-creators-treemap.js).
function renderBranchCreators(history) {
  const containerEl = document.getElementById("branch-creators-treemap");
  if (!containerEl) return;

  renderBranchCreatorsTreemap({
    containerEl,
    kpiEl: document.getElementById("branch-creators-kpi"),
    detailsEl: document.getElementById("branch-creators-details"),
    branches: computeClosedBranchesForCreators(history, activeBranchCategory),
  });
}

// P50/P85 baseline for the Aging Buckets/History panels. Both match the
// Cycle time trend KPI with "exclude cleanup" on: the latest 90-day window
// (offset 0, regardless of where that panel is paged) with detected cleanup
// branches removed. Cleanup is detected against the full dataset and its own
// overall P85, like the scatter plot does. Always excludes cleanup,
// independent of that toggle.
function computeAgingBaseline(history) {
  const fullDataset = computeCycleTimeDataset(history, activeBranchCategory);
  const cleanupKeys = cleanupBranchKeySet(
    detectCleanupEvents(fullDataset, { p85: computeCycleTimeSummary(fullDataset).p85 })
  );
  const { start, end } = cycleTimeWindowBounds(0);
  const latestWindow = fullDataset.filter((b) => {
    const closedAtMs = new Date(b.closedDate).getTime();
    return closedAtMs > start.getTime() && closedAtMs <= end.getTime() && !cleanupKeys.has(b.branchId);
  });
  return computeCycleTimeSummary(latestWindow);
}

// Aging Buckets panel — currently-open branches grouped by age against the
// dashboard's own cycle-time baseline, rendered as a waffle grid (grid +
// legend + KPI header rendering lives in aging-buckets-waffle.js, bucketing
// math in aging-buckets-math.js). The P50/P85 baseline is deliberately
// computed from the *full*, un-windowed closed-branch dataset (not the
// Cycle time trend panel's paged 90-day window just below it) — this panel
// isn't paged itself, so its SLA baseline should stay a single stable "how
// the team has performed overall" number rather than jumping around as
// someone pages through that other panel's window. Unlike the Chart.js
// charts elsewhere on this page, there's no chart instance to track/
// destroy/resize — see aging-buckets-waffle.js's own comment on why.
// P50/P85 baseline for the Aging panels, always computed with detected
// cleanup (bulk-close) branches excluded — same detection the Cycle time
// trend panel's "exclude cleanup outliers" toggle uses, but not tied to
// that toggle: these panels' SLA yardstick shouldn't be skewed by cleanups.
function computeAgingBaseline(history) {
  const fullDataset = computeCycleTimeDataset(history, activeBranchCategory);
  const cleanupKeys = cleanupBranchKeySet(
    detectCleanupEvents(fullDataset, { p85: computeCycleTimeSummary(fullDataset).p85 })
  );
  return computeCycleTimeSummary(fullDataset.filter((b) => !cleanupKeys.has(b.branchId)));
}

function renderAgingBuckets(history) {
  const gridEl = document.getElementById("aging-buckets-waffle");
  if (!gridEl) return;

  const { ages: openBranches, excludedCount } = computeOpenBranchAges(history, activeBranchCategory);
  const { p50, p85 } = computeAgingBaseline(history);

  renderAgingBucketsWaffle({
    gridEl,
    legendEl: document.getElementById("aging-buckets-legend"),
    kpiEl: document.getElementById("aging-buckets-kpi"),
    detailsEl: document.getElementById("aging-buckets-details"),
    branches: openBranches,
    excludedCount,
    p50,
    p85,
  });
}

const AGING_HISTORY_WEEKS = 12;

// The last `count` ISO Mondays at local midnight, oldest first, ending at
// (or just before) today — the Aging History table's column set.
function recentMondays(count, now = new Date()) {
  const today = startOfDay(now);
  const daysSinceMonday = (today.getDay() + 6) % 7; // getDay(): 0 = Sunday
  const thisMonday = new Date(today);
  thisMonday.setDate(thisMonday.getDate() - daysSinceMonday);

  return Array.from({ length: count }, (_, i) => {
    const d = new Date(thisMonday);
    d.setDate(d.getDate() - (count - 1 - i) * 7);
    return d;
  });
}

// True for a real hourly-collector poll, false for a synthetic
// historical-backfill entry (see CLAUDE.md's "Historical backfill" note):
// those hold exactly one merged/archived branch each with
// componentCount/styleCount left null, not a real "every branch open at
// this instant" snapshot. Shared by closestSnapshot and
// closestSnapshotForWeek's own fallback loop — both need to skip the same
// synthetic entries for the same reason.
function isRealSnapshot(snapshot) {
  return Array.isArray(snapshot.figma) && snapshot.figma[0]?.componentCount != null;
}

// The history snapshot whose timestamp is closest to `date`, or null if
// nothing is within `toleranceMs` of it — a genuine gap in hourly
// collection, not just a Monday that happens to land a few hours from the
// nearest poll. Deliberately skips synthetic historical-backfill entries —
// picking one as "the closest snapshot to this Monday" would make that
// week look like it had almost no open branches at all, when the truth is
// just "we don't have a real poll from that far back yet".
function closestSnapshot(history, date, toleranceMs = 86400000) {
  let best = null;
  let bestDiff = Infinity;
  for (const snapshot of history) {
    if (!isRealSnapshot(snapshot)) continue;
    const diff = Math.abs(new Date(snapshot.timestamp).getTime() - date.getTime());
    if (diff < bestDiff) {
      bestDiff = diff;
      best = snapshot;
    }
  }
  return bestDiff <= toleranceMs ? best : null;
}

// The real snapshot that best represents `monday`'s week: prefers one
// within a day of the Monday itself (closestSnapshot above), but — if the
// collector missed its window right around that Monday (a workflow
// failure, a runner outage) — falls back to the earliest real snapshot
// anywhere later that same week (Tue through the following Sunday) rather
// than leaving the whole week out. Forward-only: a snapshot from the
// *previous* week belongs to that week's own column, not this one. Still
// returns null if there's no real snapshot anywhere in the 7-day window —
// a genuine week-long gap, which does need to show as missing rather than
// borrowing data from further away than "the same week".
function closestSnapshotForWeek(history, monday) {
  const tight = closestSnapshot(history, monday);
  if (tight) return tight;

  const nextMonday = new Date(monday);
  nextMonday.setDate(nextMonday.getDate() + 7);

  let best = null;
  let bestTime = Infinity;
  for (const snapshot of history) {
    if (!isRealSnapshot(snapshot)) continue;
    const t = new Date(snapshot.timestamp).getTime();
    if (t < monday.getTime() || t >= nextMonday.getTime()) continue;
    if (t < bestTime) {
      bestTime = t;
      best = snapshot;
    }
  }
  return best;
}

// Maps aging-buckets-math.js's bucket ids to the Aging History table's own
// schema keys (see aging-history-math.js's header comment) — same 4
// categories, different field names since this one's a stored weekly
// record rather than a live branch list. Derived from AGING_BUCKET_DEFS
// (aging-buckets-math.js) rather than maintained as its own separate
// literal, so the two can't silently drift apart if a bucket's id or order
// ever changes.
const AGING_HISTORY_BUCKET_KEY_BY_ID = Object.fromEntries(
  AGING_BUCKET_DEFS.map((def) => [def.id, def.historyKey])
);

// One { weekNumber, mondayDate, buckets } entry per Monday in `mondays`
// (see aging-history-math.js for the exact shape) describing the
// distribution of *then*-open branches' ages, judged against the
// dashboard's *current* P50/P85 baseline — deliberately not a
// re-computed-per-week baseline, since the point of this table is "how has
// the shape of open work changed", read against one consistent yardstick,
// not "how has the yardstick itself moved" (a different question the
// Cycle time trend panel's own monthly table already answers). A branch's
// age "as of that Monday" only means anything relative to branches that
// were actually open then — this replays the real historical snapshot
// closest to each Monday (not today's open-branch set), so a since-merged
// branch still counts in the weeks it was genuinely open. If the collector
// missed its window right around a given Monday, closestSnapshotForWeek
// falls back to the earliest real snapshot later that same week rather
// than leaving the column out entirely — only a week with no real
// snapshot *anywhere* in it (a true multi-day collection gap) is skipped.
// Ages are computed against the *actual* snapshot's own timestamp, not the
// nominal Monday — when a fallback snapshot lands mid-week, that's a more
// accurate "how old was this branch when we actually observed it" than
// pretending the observation happened exactly on Monday. Only the
// week/column label (weekNumber, mondayDate) stays anchored to the Monday,
// so the table's cadence reads as weekly regardless of which day within
// the week actually supplied the data. Takes the Monday list itself
// (rather than a window size) so the caller — renderAgingHistory below —
// can page backward through arbitrarily old windows, not just the
// trailing one. `category` ('all' | 'pintxo' | 'business') restricts each
// week's branches to that manually tagged category (see getBranchCategory)
// before bucketing — applied uniformly across all history, same as every
// other category filter on this page, since a branch's category isn't
// itself time-versioned.
function computeWeeklyAgingSnapshots(history, mondays, { p50, p85 } = {}, category = "all") {
  if (p50 == null || p85 == null) return [];

  // A branch's createdAt is resolved once (paginating Figma's /versions) and
  // then cached forward by the collector — so an EARLY raw snapshot can
  // still show createdAt: null for a branch that gets resolved only later.
  // Reading straight off the picked snapshot's own branch record would
  // undercount whichever week's closest snapshot happened to predate that
  // resolution, even though the full history already knows the real date.
  // computeBranchRecords resolves this the same way computeOpenBranchAges
  // does, so look creation date up there instead of trusting the raw record.
  const records = computeBranchRecords(history);

  const snapshots = [];
  for (const monday of mondays) {
    const snapshot = closestSnapshotForWeek(history, monday);
    if (!snapshot) continue;

    const asOf = new Date(snapshot.timestamp).getTime();
    const branches = (Array.isArray(snapshot.figma) ? snapshot.figma[0]?.branches ?? [] : []).filter((b) =>
      branchMatchesCategory(b.key, category)
    );
    const buckets = { p50Under: 0, p50ToP85: 0, p85To2xP85: 0, p85Over2x: 0 };
    let excludedCount = 0;

    for (const branch of branches) {
      const createdAt = records.get(branch.key)?.createdAt ?? branch.createdAt;
      const ageInDays = createdAt ? (asOf - new Date(createdAt).getTime()) / 86400000 : null;
      // Not just `!createdAt` / `< 0`: an unparseable createdAt yields NaN,
      // and `NaN < 0` is false — same excluded-not-uncounted fix as
      // computeOpenBranchAges, so a bad record can't silently sort into the
      // "critical" bucket instead of being dropped and reported.
      if (ageInDays == null || !(ageInDays >= 0)) {
        excludedCount++;
        continue;
      }
      buckets[AGING_HISTORY_BUCKET_KEY_BY_ID[agingBucketId(ageInDays, p50, p85)]]++;
    }

    snapshots.push({ weekNumber: isoWeekNumber(monday), mondayDate: monday.toISOString(), buckets, excludedCount });
  }

  return snapshots;
}

// Windows back from "now", in units of AGING_HISTORY_WEEKS Mondays each —
// same "windows back from now" convention as branchActivityOffset/
// cycleTimeOffset. 0 is the trailing AGING_HISTORY_WEEKS Mondays, 1 is the
// AGING_HISTORY_WEEKS immediately before that, etc.
let agingHistoryOffset = 0;

function formatAgingHistoryRangeLabel(mondays) {
  const fmt = (d) => d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${fmt(mondays[0])} – ${fmt(mondays.at(-1))}`;
}

// Aging History panel — a stacked-bar companion to the Aging Buckets
// waffle just above it (chart config + derived-metrics math in
// aging-history-chart.js/aging-history-math.js). Uses the same P50/P85
// baseline as that waffle (see computeWeeklyAgingSnapshots' own comment
// for why it's not a per-week baseline) so the two panels are always
// reading off the same yardstick. Paged via agingHistoryOffset so older
// weeks (beyond the trailing AGING_HISTORY_WEEKS) are still reachable —
// paging back just shows fewer/no columns once it runs past however far
// real (non-backfill) collector data actually goes, rather than fabricating
// anything for weeks with no genuine snapshot.
function renderAgingHistory(history) {
  if (agingHistoryChart) {
    agingHistoryChart.destroy();
    agingHistoryChart = null;
  }

  const canvas = document.getElementById("chart-aging-history");
  if (!canvas) return;

  const anchor = new Date();
  anchor.setDate(anchor.getDate() - agingHistoryOffset * AGING_HISTORY_WEEKS * 7);
  const mondays = recentMondays(AGING_HISTORY_WEEKS, anchor);

  document.getElementById("aging-history-range").textContent = formatAgingHistoryRangeLabel(mondays);
  document.getElementById("aging-history-next").disabled = agingHistoryOffset === 0;

  const { p50, p85 } = computeAgingBaseline(history);
  const weeklySnapshots = computeWeeklyAgingSnapshots(history, mondays, { p50, p85 }, activeBranchCategory);

  agingHistoryChart = createAgingHistoryChart({
    canvas,
    detailsEl: document.getElementById("aging-history-details"),
    weeklySnapshots,
  });
}

function initAgingHistoryNav() {
  document.getElementById("aging-history-prev").addEventListener("click", () => {
    agingHistoryOffset += 1;
    if (cachedHistory) renderAgingHistory(cachedHistory);
  });
  document.getElementById("aging-history-next").addEventListener("click", () => {
    if (agingHistoryOffset === 0) return;
    agingHistoryOffset -= 1;
    if (cachedHistory) renderAgingHistory(cachedHistory);
  });
}

// Buckets a list of events ({ timestamp, ...detail }) into a fixed, recent
// window of period counts — 14 days, 8 weeks (7-day buckets), or 6 calendar
// months — always returning every bucket in the window (zero-filled),
// oldest first, so the chart's x-axis stays stable regardless of how sparse
// the data is. Each bucket also keeps the raw events that landed in it
// (`items`), so a caller can drill into "which branches, exactly" after the
// fact — see renderBranchActivityDetails.
function bucketEvents(events, granularity, now = new Date()) {
  const valid = events.filter((e) => e && e.timestamp).map((e) => ({ ...e, date: new Date(e.timestamp) }));

  if (granularity === "month") {
    const months = 6;
    const buckets = [];
    for (let i = months - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      buckets.push({ key: `${d.getFullYear()}-${d.getMonth()}`, start: d, label: d.toLocaleDateString(undefined, { month: "short" }), count: 0, items: [] });
    }
    for (const e of valid) {
      const key = `${e.date.getFullYear()}-${e.date.getMonth()}`;
      const bucket = buckets.find((b) => b.key === key);
      if (bucket) {
        bucket.count++;
        bucket.items.push(e);
      }
    }
    return buckets;
  }

  const bucketSizeDays = granularity === "day" ? 1 : 7;
  const bucketCount = granularity === "day" ? 14 : 8;
  const totalDays = bucketSizeDays * bucketCount;
  const today = startOfDay(now);

  const buckets = [];
  for (let i = bucketCount - 1; i >= 0; i--) {
    const bucketStart = new Date(today);
    bucketStart.setDate(bucketStart.getDate() - i * bucketSizeDays);
    const dateLabel = bucketStart.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const label = granularity === "week" ? [`W${isoWeekNumber(bucketStart)}`, dateLabel] : dateLabel;
    buckets.push({ start: bucketStart, count: 0, label, items: [] });
  }

  for (const e of valid) {
    // Calendar-day difference via Date.UTC of each date's own Y/M/D, not a
    // raw ms subtraction of two local-midnight Dates divided by 86400000 —
    // a day spanning a DST transition is 23h or 25h of real time, not 24h,
    // which shifted events by one day right at the transition boundary.
    // Date.UTC has no DST, so this is exact regardless of local timezone.
    const eDay = startOfDay(e.date);
    const daysAgo = Math.round(
      (Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()) -
        Date.UTC(eDay.getFullYear(), eDay.getMonth(), eDay.getDate())) /
        86400000
    );
    if (daysAgo < 0 || daysAgo >= totalDays) continue;
    const bucketIndex = bucketCount - 1 - Math.floor(daysAgo / bucketSizeDays);
    if (buckets[bucketIndex]) {
      buckets[bucketIndex].count++;
      buckets[bucketIndex].items.push(e);
    }
  }

  return buckets;
}

// The "now" a bucketed window is anchored to, shifted back by `offset` whole
// window-lengths (14 days / 8 weeks / 6 months) — offset 0 is the current
// window, 1 is the window immediately before it, etc.
function branchActivityAnchor(granularity, offset, now = new Date()) {
  if (offset === 0) return now;
  if (granularity === "month") {
    // Day fixed at 1, not now.getDate(): bucketEvents' month path only ever
    // reads the anchor's year/month, but new Date(y, m, day) rolls over into
    // the next month when `day` doesn't exist there (e.g. day=31 shifted to
    // a month with 30 or fewer days) — carrying over today's day-of-month
    // risked silently shifting the whole 6-month window.
    return new Date(now.getFullYear(), now.getMonth() - offset * 6, 1);
  }
  const bucketSizeDays = granularity === "day" ? 1 : 7;
  const bucketCount = granularity === "day" ? 14 : 8;
  const anchor = new Date(now);
  anchor.setDate(anchor.getDate() - offset * bucketSizeDays * bucketCount);
  return anchor;
}

function formatBucketRangeLabel(buckets, granularity) {
  const fmt =
    granularity === "month"
      ? (d) => d.toLocaleDateString(undefined, { month: "short", year: "numeric" })
      : (d) => d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${fmt(buckets[0].start)} – ${fmt(buckets.at(-1).start)}`;
}

function groupedBarChart(canvasId, labels, createdData, mergedData, createdColor, mergedColor, onBarClick) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const muted = getCssVar("--ink-muted");
  const gridline = getCssVar("--gridline");
  const surface = getCssVar("--surface");

  if (branchActivityChart) branchActivityChart.destroy();

  branchActivityChart = new Chart(canvas, {
    type: "bar",
    data: {
      labels,
      datasets: [
        { label: "Created", data: createdData, backgroundColor: createdColor, borderRadius: 3, maxBarThickness: 18 },
        { label: "Closed", data: mergedData, backgroundColor: mergedColor, borderRadius: 3, maxBarThickness: 18 },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      // The tooltip stays in "index" mode (both bars at once, like every
      // other chart here), but a click needs to know exactly *which* bar —
      // Created or Closed — was hit, so it's resolved separately with
      // intersect:true against the real click point rather than reused from
      // the hover-driven `elements` array.
      onHover: (evt, elements) => {
        if (evt.native?.target) evt.native.target.style.cursor = elements.length && onBarClick ? "pointer" : "default";
      },
      onClick: (evt, _elements, chart) => {
        if (!onBarClick) return;
        const hit = chart.getElementsAtEventForMode(evt, "nearest", { intersect: true }, true);
        if (!hit.length) return;
        onBarClick(hit[0].datasetIndex, hit[0].index);
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: surface,
          borderColor: getCssVar("--border"),
          borderWidth: 1,
          titleColor: muted,
          bodyColor: getCssVar("--ink"),
          padding: 10,
          boxPadding: 4,
          cornerRadius: 8,
        },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { color: muted, font: { size: 10 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 8 },
        },
        y: {
          // Unlike the line charts above, these are discrete counts being
          // compared bar-to-bar, so the y-axis starts at zero — a non-zero
          // baseline would visually misrepresent the comparison.
          beginAtZero: true,
          grid: { color: gridline, drawTicks: false },
          border: { display: false },
          ticks: { color: muted, font: { size: 10 }, maxTicksLimit: 4, precision: 0 },
        },
      },
    },
  });
}

// The single-bucket range a clicked bar covers — a day, a Mon–Sun week, or
// a calendar month — distinct from formatBucketRangeLabel above (which
// spans the whole visible window across every bucket).
function formatBranchActivityBucketRangeLabel(bucket, granularity) {
  if (granularity === "month") {
    return bucket.start.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  }
  const fmt = (d) => d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  if (granularity === "day") return fmt(bucket.start);
  const end = new Date(bucket.start);
  end.setDate(end.getDate() + 6);
  return `${fmt(bucket.start)} – ${fmt(end)}`;
}

// The click-to-expand panel for a bar the user clicked on the Branch
// activity chart: every branch behind that bar's count, with the same
// author/date detail the other charts' hover tooltips show (see
// cycle-time-scatter.js's tooltip and the waffle chart's
// showWaffleTooltip) — just persistent instead of hover-only, since a bar
// can represent dozens of branches at once. Re-invoked with `bucket: null`
// by its own close button, same pattern as the Aging Buckets/History panels.
function renderBranchActivityDetails(detailsEl, bucket, kind, granularity) {
  if (!detailsEl) return;

  if (!bucket || bucket.items.length === 0) {
    detailsEl.hidden = true;
    detailsEl.innerHTML = "";
    return;
  }

  detailsEl.hidden = false;

  const kindLabel = kind === "created" ? "Created" : "Closed";
  const rangeLabel = formatBranchActivityBucketRangeLabel(bucket, granularity);

  const rows = [...bucket.items]
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .map(
      (item) => `
      <div class="aging-branch-row">
        <a
          class="aging-branch-name aging-branch-name-link"
          href="https://www.figma.com/file/${item.key}"
          target="_blank"
          rel="noopener"
        >${escapeHtml(item.name)}</a>
        <span class="aging-branch-age">${escapeHtml(item.authorHandle) || "Unknown"} · ${fmtBranchDate(item.timestamp)}</span>
      </div>`
    )
    .join("");

  detailsEl.innerHTML = `
    <div class="aging-branch-details-head">
      <p><strong>${kindLabel}</strong> — ${rangeLabel} — ${bucket.items.length} branch${bucket.items.length === 1 ? "" : "es"}</p>
      <button type="button" class="aging-branch-details-close" aria-label="Close branch list">✕</button>
    </div>
    <div class="aging-branch-list">${rows}</div>
  `;

  detailsEl.querySelector(".aging-branch-details-close").addEventListener("click", () => {
    renderBranchActivityDetails(detailsEl, null);
  });
}

function renderBranchActivity(history) {
  const { createdEvents, mergedEvents } = computeBranchLifecycles(history, activeBranchCategory);
  const anchor = branchActivityAnchor(branchActivityGranularity, branchActivityOffset);
  const createdBuckets = bucketEvents(createdEvents, branchActivityGranularity, anchor);
  const mergedBuckets = bucketEvents(mergedEvents, branchActivityGranularity, anchor);

  const labels = createdBuckets.map((b) => b.label);
  const createdCounts = createdBuckets.map((b) => b.count);
  const mergedCounts = mergedBuckets.map((b) => b.count);

  setValueText("value-branch-activity-created", createdCounts.reduce((a, b) => a + b, 0));
  setValueText("value-branch-activity-merged", mergedCounts.reduce((a, b) => a + b, 0));

  const detailsEl = document.getElementById("branch-activity-details");
  // The previously-selected bar (if any) may no longer correspond to
  // anything meaningful once the data/window/granularity has changed
  // underneath it — same reset-on-rerender behavior as the Aging Buckets
  // and Aging History panels.
  renderBranchActivityDetails(detailsEl, null);

  groupedBarChart(
    "chart-branch-activity",
    labels,
    createdCounts,
    mergedCounts,
    getCssVar("--accent-figma"),
    getCssVar("--ink-muted"),
    (datasetIndex, index) => {
      const bucket = datasetIndex === 0 ? createdBuckets[index] : mergedBuckets[index];
      const kind = datasetIndex === 0 ? "created" : "merged";
      renderBranchActivityDetails(detailsEl, bucket, kind, branchActivityGranularity);
    }
  );

  document.getElementById("branch-activity-range").textContent = formatBucketRangeLabel(
    createdBuckets,
    branchActivityGranularity
  );
  document.getElementById("branch-activity-next").disabled = branchActivityOffset === 0;
}

function initBranchActivityToggle() {
  const buttons = [
    { id: "granularity-day", value: "day" },
    { id: "granularity-week", value: "week" },
    { id: "granularity-month", value: "month" },
  ];

  buttons.forEach(({ id, value }) => {
    document.getElementById(id).addEventListener("click", () => {
      branchActivityGranularity = value;
      branchActivityOffset = 0;
      buttons.forEach(({ id: otherId }) => document.getElementById(otherId).classList.remove("active"));
      document.getElementById(id).classList.add("active");
      if (cachedHistory) renderBranchActivity(cachedHistory);
    });
  });
}

function initBranchActivityNav() {
  document.getElementById("branch-activity-prev").addEventListener("click", () => {
    branchActivityOffset += 1;
    if (cachedHistory) renderBranchActivity(cachedHistory);
  });
  document.getElementById("branch-activity-next").addEventListener("click", () => {
    if (branchActivityOffset === 0) return;
    branchActivityOffset -= 1;
    if (cachedHistory) renderBranchActivity(cachedHistory);
  });
}

// The floating "Jump to" index only ever shows the section list for
// whichever tab is actually open (a link into a hidden tab's content isn't
// useful), and the floating category filter — which only ever affects
// Branches-tab panels — hides itself on Overview for the same reason.
// Called once up front for the tab that's already selected in the markup
// (Branches, by default), then again on every tab click.
function syncFloatingControlsToTab(tabButtonId) {
  document.querySelectorAll(".widget-index-tab-group").forEach((group) => {
    group.hidden = group.dataset.tabGroup !== tabButtonId;
  });
  const categoryFilterBar = document.getElementById("category-filter-bar");
  if (categoryFilterBar) categoryFilterBar.hidden = tabButtonId !== "tab-branches";
}

function initTabs() {
  const tabs = [
    { button: document.getElementById("tab-overview"), panel: document.getElementById("panel-overview") },
    { button: document.getElementById("tab-branches"), panel: document.getElementById("panel-branches") },
  ];

  const initiallySelected = tabs.find(({ button }) => button.getAttribute("aria-selected") === "true");
  if (initiallySelected) syncFloatingControlsToTab(initiallySelected.button.id);

  tabs.forEach(({ button, panel }) => {
    button.addEventListener("click", () => {
      tabs.forEach(({ button: b, panel: p }) => {
        const active = b === button;
        b.setAttribute("aria-selected", String(active));
        p.hidden = !active;
      });
      syncFloatingControlsToTab(button.id);

      // Chart.js measures its canvas's container to size itself. That
      // container has zero width while a panel is `hidden` — true for
      // Overview the first time main() renders it, since Branches is the
      // default open tab, and also reachable for Branches' own charts if
      // they get destroyed/recreated (e.g. a theme toggle) while Overview
      // is the visible tab — and Chart.js's ResizeObserver doesn't always
      // pick up the change in time for the first paint after the panel
      // becomes visible. resize() forces an immediate re-measure. Resize
      // whichever panel just became visible, not just Overview's charts.
      if (panel.id === "panel-overview") {
        charts.forEach((c) => c.resize());
      } else if (panel.id === "panel-branches") {
        [branchActivityChart, cycleTimeScatterChart, agingHistoryChart].forEach((c) => c?.resize());
      }
    });
  });
}

function setWidgetIndexCollapsed(nav, toggle, collapsed) {
  nav.classList.toggle("collapsed", collapsed);
  toggle.setAttribute("aria-expanded", String(!collapsed));
}

function initWidgetIndexScrollSpy(links) {
  const intersecting = new Set();
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) intersecting.add(entry.target.id);
        else intersecting.delete(entry.target.id);
      });
      // `links` is already in top-to-bottom DOM order, so the first one
      // whose target is currently intersecting is the topmost visible
      // section — the one a reader would call "where I am".
      const current = links.find((link) => intersecting.has(link.dataset.target));
      links.forEach((link) => link.classList.toggle("active", link === current));
    },
    { rootMargin: "-96px 0px -70% 0px" }
  );

  function observeVisibleTab() {
    observer.disconnect();
    intersecting.clear();
    links.forEach((link) => link.classList.remove("active"));
    links.forEach((link) => {
      const target = document.getElementById(link.dataset.target);
      const panel = target && target.closest(".tab-panel");
      if (target && panel && !panel.hidden) observer.observe(target);
    });
  }

  observeVisibleTab();
  // The tab-switch handler in initTabs (registered first) flips `hidden`
  // synchronously; wait a frame before re-observing so we don't try to
  // observe elements that are still hidden.
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => requestAnimationFrame(observeVisibleTab));
  });
}

function positionWidgetIndex(nav) {
  // The topbar isn't fixed/sticky, so its rendered height (title + "Last
  // updated" line, which can wrap to two lines on a narrow viewport) only
  // reflects reality pre-scroll — recomputed on load/resize, not on
  // scroll, so the index doesn't chase the topbar back into view as it
  // scrolls out of frame.
  const topbar = document.querySelector(".topbar");
  const bottom = topbar ? topbar.getBoundingClientRect().bottom : 0;
  nav.style.top = `${Math.max(16, bottom + 12)}px`;
}

function initWidgetIndex() {
  const nav = document.getElementById("widget-index");
  const toggle = document.getElementById("widget-index-toggle");
  const links = Array.from(document.querySelectorAll(".widget-index-link"));

  positionWidgetIndex(nav);
  window.addEventListener("resize", () => positionWidgetIndex(nav));

  let collapsed = window.matchMedia("(max-width: 900px)").matches;
  try {
    const stored = localStorage.getItem(WIDGET_INDEX_COLLAPSED_KEY);
    if (stored === "true" || stored === "false") collapsed = stored === "true";
  } catch (e) {
    // Private browsing / storage disabled — collapsed state just won't persist.
  }
  setWidgetIndexCollapsed(nav, toggle, collapsed);

  toggle.addEventListener("click", () => {
    const next = !nav.classList.contains("collapsed");
    setWidgetIndexCollapsed(nav, toggle, next);
    try {
      localStorage.setItem(WIDGET_INDEX_COLLAPSED_KEY, String(next));
    } catch (e) {
      // Private browsing / storage disabled — collapsed state just won't persist.
    }
  });

  links.forEach((link) => {
    link.addEventListener("click", () => {
      const tabButton = document.getElementById(link.dataset.tab);
      const target = document.getElementById(link.dataset.target);
      if (!tabButton || !target) return;

      if (tabButton.getAttribute("aria-selected") !== "true") {
        tabButton.click();
        // The tab-switch handler flips `hidden` synchronously, but the
        // panel's layout (and therefore scrollIntoView's target position)
        // isn't settled until the next frame.
        requestAnimationFrame(() => target.scrollIntoView({ behavior: "smooth", block: "start" }));
      } else {
        target.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
  });

  initWidgetIndexScrollSpy(links);
}

function fmtBranchDate(iso) {
  if (!iso) return "Unknown";
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function daysOpenLabel(createdAt) {
  if (!createdAt) return "—";
  const days = Math.max(0, Math.floor((Date.now() - new Date(createdAt)) / 86400000));
  return `${days} day${days === 1 ? "" : "s"} open`;
}

function escapeHtml(value) {
  if (value == null) return "";
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderBranches(history) {
  const container = document.getElementById("branches-list");
  const openKeys = getLatestOpenKeys(history.at(-1));

  if (!openKeys) {
    container.innerHTML = `<p class="branch-empty">Couldn't load branch data — Figma collection isn't working right now.</p>`;
    return;
  }

  const records = computeBranchRecords(history);

  if (records.size === 0) {
    container.innerHTML = `<p class="branch-empty">No branches seen yet.</p>`;
    return;
  }

  const hideMerged = document.getElementById("branch-filter-hide-merged").checked;

  const byStatus = hideMerged
    ? [...records.values()].filter((branch) => openKeys.has(branch.key))
    : [...records.values()];
  const filtered = byStatus.filter((branch) => branchMatchesCategory(branch.key, activeBranchCategory));

  if (filtered.length === 0) {
    container.innerHTML = `<p class="branch-empty">No branches match the current filters.</p>`;
    return;
  }

  const sorted = filtered.sort(
    (a, b) =>
      new Date(b.createdAt ?? b.lastSeenAt ?? 0) - new Date(a.createdAt ?? a.lastSeenAt ?? 0)
  );

  const totalPages = Math.max(1, Math.ceil(sorted.length / branchesPerPage));
  if (branchesPage >= totalPages) branchesPage = totalPages - 1;
  const pageStart = branchesPage * branchesPerPage;
  const page = sorted.slice(pageStart, pageStart + branchesPerPage);

  renderBranchesPagination(sorted.length, totalPages);

  container.innerHTML = page
    .map((branch) => {
      const isOpen = openKeys.has(branch.key);
      const url = `https://www.figma.com/file/${branch.key}`;
      const statusTag = isOpen
        ? `<span class="branch-status branch-status-open">Open</span>`
        : `<span class="branch-status branch-status-merged">Closed</span>`;
      const ageLabel = isOpen
        ? daysOpenLabel(branch.createdAt)
        : `Last seen ${fmtBranchDate(branch.lastSeenAt)}`;
      const category = getBranchCategory(branch.key);
      return `
      <div class="branch-card${isOpen ? "" : " branch-card-merged"}">
        <div class="branch-card-head">
          <p class="branch-name">${escapeHtml(branch.name)}</p>
          ${statusTag}
          <span class="branch-age">${ageLabel}</span>
        </div>
        <dl class="branch-meta-grid">
          <div class="branch-meta-item">
            <dt>Created by</dt>
            <dd>${escapeHtml(branch.createdByHandle) || "Unknown"}</dd>
          </div>
          <div class="branch-meta-item">
            <dt>Created</dt>
            <dd>${fmtBranchDate(branch.createdAt)}</dd>
          </div>
          <div class="branch-meta-item">
            <dt>Last edited by</dt>
            <dd>${escapeHtml(branch.lastEditedByHandle) || "Unknown"}</dd>
          </div>
          <div class="branch-meta-item">
            <dt>Last edited</dt>
            <dd>${fmtBranchDate(branch.lastEditedAt)}</dd>
          </div>
        </dl>
        <div class="branch-category-row">
          <label class="branch-category-label" for="branch-category-${branch.key}">Category</label>
          <select class="branch-category-select" id="branch-category-${branch.key}" data-key="${branch.key}">
            <option value="" ${category ? "" : "selected"}>Unassigned</option>
            <option value="pintxo" ${category === "pintxo" ? "selected" : ""}>Pintxo component</option>
            <option value="business" ${category === "business" ? "selected" : ""}>Business component</option>
          </select>
        </div>
        <div class="branch-actions">
          <a
            class="branch-btn branch-btn-primary"
            href="${url}"
            target="_blank"
            rel="noopener"
          >Open in Figma ↗</a>
          <button type="button" class="branch-btn branch-btn-secondary" data-action="copy" data-url="${url}">
            Copy link
          </button>
        </div>
      </div>`;
    })
    .join("");
}

function renderBranchesPagination(totalBranches, totalPages) {
  document.getElementById("branches-page-label").textContent =
    `Page ${branchesPage + 1} of ${totalPages} (${totalBranches} branch${totalBranches === 1 ? "" : "es"})`;
  document.getElementById("branches-prev").disabled = branchesPage === 0;
  document.getElementById("branches-next").disabled = branchesPage >= totalPages - 1;
}

function scrollBranchesToTop() {
  document.getElementById("branches-list").scrollIntoView({ behavior: "smooth", block: "start" });
}

function initBranchesNav() {
  document.getElementById("branches-prev").addEventListener("click", () => {
    if (branchesPage === 0) return;
    branchesPage -= 1;
    if (cachedHistory) renderBranches(cachedHistory);
    scrollBranchesToTop();
  });
  document.getElementById("branches-next").addEventListener("click", () => {
    branchesPage += 1;
    if (cachedHistory) renderBranches(cachedHistory);
    scrollBranchesToTop();
  });
}

function initBranchActions() {
  const container = document.getElementById("branches-list");
  container.addEventListener("click", async (e) => {
    const button = e.target.closest('[data-action="copy"]');
    if (!button || !navigator.clipboard?.writeText) return;

    try {
      await navigator.clipboard.writeText(button.dataset.url);
      const original = button.textContent;
      button.textContent = "Copied!";
      setTimeout(() => {
        button.textContent = original;
      }, 1500);
    } catch (err) {
      console.error(err);
    }
  });
}

// Delegated on #branches-list (same pattern as initBranchActions' copy-link
// listener) since branch cards are re-rendered wholesale on every
// renderBranches call. Writes straight to the draft (see
// setBranchCategoryDraft) — there's no backend to persist to directly, so
// this is a local staging edit until it's exported and committed to
// metrics-data by hand (see CLAUDE.md).
function initBranchCategorySelects() {
  const container = document.getElementById("branches-list");
  container.addEventListener("change", (e) => {
    const select = e.target.closest(".branch-category-select");
    if (!select) return;
    setBranchCategoryDraft(select.dataset.key, select.value || null);
    if (!cachedHistory) return;
    renderBranches(cachedHistory);
    // Only re-render the other category-filtered views when a filter is
    // actually active — an edit while viewing "All" can't change what's
    // shown there.
    if (activeBranchCategory !== "all") {
      renderBranchActivity(cachedHistory);
      renderAgingBuckets(cachedHistory);
      renderAgingHistory(cachedHistory);
      renderCycleTimeScatterChart(cachedHistory);
      renderBranchCreators(cachedHistory);
    }
  });
}

// All/Pintxo/Business toggle scoped to the Branches tab (Branch activity,
// Aging buckets & history, Cycle time trend, Branch creators, Library
// branches) — Overview has no per-branch attribution, so it's never
// re-rendered here. Reuses the granularity toggle's segmented-button
// markup/styling (see index.html).
function initBranchCategoryFilter() {
  const buttons = [
    { id: "category-filter-all", value: "all" },
    { id: "category-filter-pintxo", value: "pintxo" },
    { id: "category-filter-business", value: "business" },
  ];

  let saved = "all";
  try {
    const stored = localStorage.getItem(BRANCH_CATEGORY_FILTER_KEY);
    if (buttons.some((b) => b.value === stored)) saved = stored;
  } catch (e) {
    // Private browsing / storage disabled — the filter just won't persist.
  }
  activeBranchCategory = saved;
  buttons.forEach(({ id, value }) => {
    document.getElementById(id).classList.toggle("active", value === saved);
  });

  buttons.forEach(({ id, value }) => {
    document.getElementById(id).addEventListener("click", () => {
      activeBranchCategory = value;
      buttons.forEach(({ id: otherId }) => document.getElementById(otherId).classList.remove("active"));
      document.getElementById(id).classList.add("active");
      try {
        localStorage.setItem(BRANCH_CATEGORY_FILTER_KEY, value);
      } catch (e) {
        // Private browsing / storage disabled — the filter just won't persist.
      }
      branchesPage = 0;
      if (!cachedHistory) return;
      renderBranchActivity(cachedHistory);
      renderAgingBuckets(cachedHistory);
      renderAgingHistory(cachedHistory);
      renderCycleTimeScatterChart(cachedHistory);
      renderBranchCreators(cachedHistory);
      renderBranches(cachedHistory);
    });
  });
}

// This static page has no write path of its own back to metrics-data (see
// CLAUDE.md — embedding a repo-write credential here would expose it to
// anyone who can view-source the page). Instead, merges the committed
// baseline with this session's draft edits, copies the result to the
// clipboard, and opens publish-branch-categories.yml's "Run workflow" page —
// pasting there and clicking Run performs the actual commit-to-metrics-data
// + deploy-trigger, authenticated as whoever runs it via GitHub's own UI.
const PUBLISH_BRANCH_CATEGORIES_WORKFLOW_URL =
  "https://github.com/Glovo/ux-tools/actions/workflows/publish-branch-categories.yml";

function initBranchCategoryPublish() {
  const button = document.getElementById("branch-category-publish");
  if (!button || !navigator.clipboard?.writeText) return;

  button.addEventListener("click", async () => {
    const merged = { ...branchCategories };
    for (const [key, value] of Object.entries(branchCategoriesDraft)) {
      if (value) merged[key] = value;
      else delete merged[key];
    }
    // Minified, not pretty-printed — GitHub's workflow_dispatch text input
    // is meant for a single value, and a minified string pastes cleanly
    // regardless of how that field renders. The workflow itself
    // re-serializes it sorted/pretty for the actual metrics-data commit.
    const json = JSON.stringify(merged);

    try {
      await navigator.clipboard.writeText(json);
      window.open(PUBLISH_BRANCH_CATEGORIES_WORKFLOW_URL, "_blank", "noopener");
      const original = button.textContent;
      button.textContent = "Copied — paste on GitHub ↗";
      setTimeout(() => {
        button.textContent = original;
      }, 2500);
    } catch (err) {
      console.error(err);
    }
  });
}

function initBranchFilter() {
  const checkbox = document.getElementById("branch-filter-hide-merged");

  let hideMerged = false;
  try {
    hideMerged = localStorage.getItem(HIDE_MERGED_BRANCHES_KEY) === "true";
  } catch (e) {
    // Private browsing / storage disabled — filter just won't persist.
  }
  checkbox.checked = hideMerged;

  checkbox.addEventListener("change", () => {
    try {
      localStorage.setItem(HIDE_MERGED_BRANCHES_KEY, String(checkbox.checked));
    } catch (e) {
      // Private browsing / storage disabled — filter just won't persist.
    }
    branchesPage = 0;
    if (cachedHistory) renderBranches(cachedHistory);
  });
}

function initBranchesPerPage() {
  const select = document.getElementById("branches-per-page");

  let saved = BRANCHES_PER_PAGE_OPTIONS[0];
  try {
    const stored = Number(localStorage.getItem(BRANCHES_PER_PAGE_KEY));
    if (BRANCHES_PER_PAGE_OPTIONS.includes(stored)) saved = stored;
  } catch (e) {
    // Private browsing / storage disabled — selection just won't persist.
  }
  branchesPerPage = saved;
  select.value = String(saved);

  select.addEventListener("change", () => {
    branchesPerPage = Number(select.value);
    try {
      localStorage.setItem(BRANCHES_PER_PAGE_KEY, String(branchesPerPage));
    } catch (e) {
      // Private browsing / storage disabled — selection just won't persist.
    }
    branchesPage = 0;
    if (cachedHistory) renderBranches(cachedHistory);
  });
}

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  document.getElementById("theme-toggle-icon").textContent = theme === "light" ? "☀" : "☾";
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch (e) {
    // Private browsing / storage disabled — theme just won't persist.
  }
  if (cachedHistory) {
    renderCharts(cachedHistory);
    renderBranchActivity(cachedHistory);
    renderCycleTimeScatterChart(cachedHistory);
    // Aging history is a Chart.js chart again (unlike the waffle below),
    // so it does need re-rendering — its axis/tooltip colors are read
    // from CSS variables once at creation time, same as every other
    // Chart.js chart on this page.
    renderAgingHistory(cachedHistory);
    // Aging buckets is deliberately not re-rendered here — its colors are
    // fixed hex, not theme-read CSS variables, and everything else in it
    // (tiles, legend text) re-themes for free via CSS. Re-rendering would
    // just reset any open bucket-detail selection for no visual benefit.
  }
}

function currentTheme() {
  return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
}

function initThemeToggle() {
  const button = document.getElementById("theme-toggle");
  document.getElementById("theme-toggle-icon").textContent = currentTheme() === "light" ? "☀" : "☾";
  button.addEventListener("click", () => {
    applyTheme(currentTheme() === "light" ? "dark" : "light");
  });
}

async function main() {
  initThemeToggle();
  initTabs();
  initWidgetIndex();
  initBranchActions();
  initBranchCategorySelects();
  initBranchCategoryFilter();
  initBranchCategoryPublish();
  initBranchFilter();
  initBranchesPerPage();
  initBranchesNav();
  initBranchActivityToggle();
  initBranchActivityNav();
  initCycleTimeNav();
  initCycleTimeCleanupToggle();
  initAgingHistoryNav();

  branchCategoriesDraft = loadBranchCategoriesDraft();
  const [history, categories] = await Promise.all([loadHistory(), loadBranchCategories()]);
  branchCategories = categories;

  if (history.length === 0) {
    document.getElementById("updated").textContent =
      "No snapshots yet — run the collector workflow once to get started.";
    return;
  }

  cachedHistory = history;
  const latest = history.at(-1);
  document.getElementById("updated").textContent = `Last updated ${fmtDate(latest.timestamp)}`;

  renderTiles(history);
  renderCharts(history);
  renderBranches(history);
  renderBranchActivity(history);
  renderAgingBuckets(history);
  renderAgingHistory(history);
  renderCycleTimeScatterChart(history);
  renderBranchCreators(history);
}

main().catch((err) => {
  document.getElementById("updated").textContent = "Couldn't load metrics — check the console.";
  console.error(err);
});
