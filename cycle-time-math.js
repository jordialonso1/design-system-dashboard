// Pure data-transformation functions behind the Cycle Time Scatter Plot's
// analytical layers (see cycle-time-scatter.js, which is the only consumer
// today). No DOM/Chart.js dependencies here — safe to unit test or reuse
// elsewhere. A "branch" throughout this file means, at minimum,
// { durationDays: number, closedDate: ISOString } — extra fields (e.g. a
// createdDate used only for display elsewhere) are ignored.

// Linear-interpolation percentile (the "PERCENTILE.INC" convention — matches
// Excel/Google Sheets' default PERCENTILE function). `sortedAsc` must
// already be sorted ascending; this does no sorting itself since callers
// usually already have a sorted array lying around and re-sorting per call
// would be wasted work in the rolling-window function below.
function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return null;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const rank = (p / 100) * (sortedAsc.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sortedAsc[lower];
  const weight = rank - lower;
  return sortedAsc[lower] * (1 - weight) + sortedAsc[upper] * weight;
}

// Overall P50 (median) and P85 across every branch passed in — the two
// "current cycle time" headline numbers.
function computeCycleTimeSummary(branches) {
  const durationsAsc = branches.map((b) => b.durationDays).sort((a, b) => a - b);
  return {
    p50: percentile(durationsAsc, 50),
    p85: percentile(durationsAsc, 85),
  };
}

// Trailing rolling P50/P85, sampled every `stepDays` across the full date
// range spanned by `branches`. Each sample at date D uses only branches
// closed in (D - windowDays, D] — a trailing window, not a centered one, so
// the curve only ever reflects data "known as of" that date (no
// look-ahead). A sample with no branches in its window gets `p50: null,
// p85: null` (a gap, not a misleading zero) rather than being dropped, so a
// chart can zero-fill/skip consistently across the whole series.
//
// Branches are sorted once by close time up front, then the window is
// tracked with two pointers advancing forward together with the sample
// date — cheaper than re-filtering the full array at every one of the
// (rangeDays / stepDays) samples.
function computeRollingPercentiles(branches, { windowDays = 30, stepDays = 1 } = {}) {
  if (branches.length === 0) return [];

  const windowMs = windowDays * 86400000;
  const stepMs = stepDays * 86400000;

  const sorted = branches
    .map((b) => ({ closedAtMs: new Date(b.closedDate).getTime(), durationDays: b.durationDays }))
    .sort((a, b) => a.closedAtMs - b.closedAtMs);

  const minDate = sorted[0].closedAtMs;
  const maxDate = sorted[sorted.length - 1].closedAtMs;

  const samples = [];
  let windowStart = 0; // inclusive
  let windowEnd = 0; // exclusive

  for (let date = minDate; date <= maxDate; date += stepMs) {
    const lowerBound = date - windowMs;
    while (windowStart < sorted.length && sorted[windowStart].closedAtMs <= lowerBound) windowStart++;
    while (windowEnd < sorted.length && sorted[windowEnd].closedAtMs <= date) windowEnd++;

    const windowDurationsAsc = sorted
      .slice(windowStart, windowEnd)
      .map((b) => b.durationDays)
      .sort((a, b) => a - b);

    samples.push({
      date,
      p50: percentile(windowDurationsAsc, 50),
      p85: percentile(windowDurationsAsc, 85),
    });
  }

  return samples;
}

// Ordinary least-squares fit of durationDays ~ closedDate across every
// branch, for a "cycle time is trending up/down" trendline. `x` values
// (millisecond timestamps, ~1.7e12) are centered on their mean before
// fitting — summing x^2 directly at that magnitude loses meaningful
// precision in a float64 — and `predict` re-applies that centering
// internally, so callers just pass a normal timestamp in and a duration
// comes out.
function computeLinearRegression(branches) {
  const points = branches.map((b) => ({
    x: new Date(b.closedDate).getTime(),
    y: b.durationDays,
  }));

  if (points.length < 2) {
    const flat = points[0]?.y ?? 0;
    return { slope: 0, intercept: flat, predict: () => flat };
  }

  const xMean = points.reduce((sum, p) => sum + p.x, 0) / points.length;
  const yMean = points.reduce((sum, p) => sum + p.y, 0) / points.length;

  let numerator = 0;
  let denominator = 0;
  for (const p of points) {
    const dx = p.x - xMean;
    numerator += dx * (p.y - yMean);
    denominator += dx * dx;
  }

  const slope = denominator === 0 ? 0 : numerator / denominator;
  const intercept = yMean - slope * xMean;

  return {
    slope, // duration-days per millisecond of calendar time (tiny by construction — scale it before displaying, e.g. slope * 86400000 * 30 for "days of duration change per month")
    intercept, // already de-centered (yMean - slope * xMean), so predict is the plain line equation
    predict: (x) => intercept + slope * x,
  };
}

function mean(values) {
  return values.length === 0 ? null : values.reduce((sum, v) => sum + v, 0) / values.length;
}

function median(values) {
  return percentile(values.slice().sort((a, b) => a - b), 50);
}

// Sample standard deviation (n-1 divisor) — undefined/meaningless below 2
// points, which callers must check for themselves via the `n` they already
// have rather than this returning some misleading placeholder.
function stdev(values) {
  if (values.length < 2) return null;
  const m = mean(values);
  const variance = values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

// A trailing month-over-month percentage (this month vs. the single month
// before it) is exactly the kind of comparison that reads as a clear signal
// but usually isn't one: cycle time is a percentile of a handful of
// branches, so one slow branch closing in an otherwise-quiet month can
// swing P85 by 50%+ with no real change in how the team is working. A
// trailing multi-month baseline absorbs that noise; see
// `computeMonthlyCycleTimeStats` for where this is actually used.
const BASELINE_WINDOW_MONTHS = 3;

// A percentile computed from too few branches is unstable almost by
// definition — P85 of 4 branches is really just "the 3rd-highest value",
// which swings wildly month to month regardless of any real trend. Below
// this many closed branches (current month or summed across the baseline
// window), a month is flagged as too thin to draw a conclusion from rather
// than scored for drift at all.
const MIN_BRANCHES_FOR_SIGNAL = 5;

// Classifies how a month's value compares to its baseline, folding in both
// the size of the deviation and how much data backs it up. This is a
// deliberately simple heuristic, not a real hypothesis test — the baseline
// is at most 3 months of data, nowhere near enough for a rigorous z-test —
// but it's enough to separate "probably just noise" from "worth a second
// look" without over-reacting to a single volatile month.
//   - "new"          — no prior months to compare against yet.
//   - "low-volume"   — current month or the baseline itself is too thin
//                       (< MIN_BRANCHES_FOR_SIGNAL branches) to trust either
//                       side of the comparison.
//   - "stable"       — within ~1 baseline standard deviation (or, when the
//                       baseline is a single month and has no spread to
//                       measure, within 15%).
//   - "notable"      — 1-2 standard deviations (or 15-35%): worth watching,
//                       not yet worth calling a trend.
//   - "drift"        — beyond 2 standard deviations (or 35%): large enough,
//                       on enough data, to likely be a real change.
function classifyMonthlyDrift({ current, baseline, currentBranchCount }) {
  if (baseline.monthCount === 0) return "new";
  if (currentBranchCount < MIN_BRANCHES_FOR_SIGNAL || baseline.branchCount < MIN_BRANCHES_FOR_SIGNAL) {
    return "low-volume";
  }
  if (current == null || baseline.mean == null) return "new";

  const deviation = Math.abs(current - baseline.mean);
  if (baseline.stdev != null && baseline.stdev > 0) {
    const z = deviation / baseline.stdev;
    return z < 1 ? "stable" : z < 2 ? "notable" : "drift";
  }
  // No usable spread (a single-month baseline has nothing to take a stdev
  // of) — fall back to a flat *absolute*-day band, not a percentage one.
  // A percentage here would be its own source of false alarms: cycle times
  // are often well under a day, so "0.2d -> 0.5d" is a real but tiny change
  // that a percentage reports as "+150%", indistinguishable from an
  // actually-alarming jump on a slower metric.
  return deviation < 1 ? "stable" : deviation < 3 ? "notable" : "drift";
}

// Builds the { mean, median, stdev, monthCount, branchCount } baseline for
// one percentile from whichever of the up-to-BASELINE_WINDOW_MONTHS
// preceding months actually exist (fewer than that near the start of
// history — `monthCount` tells the caller how many actually contributed).
function computeBaseline(precedingMonths, key) {
  const values = precedingMonths.map((m) => m[key]).filter((v) => v != null);
  return {
    mean: mean(values),
    median: median(values),
    stdev: stdev(values),
    monthCount: values.length,
    branchCount: precedingMonths.reduce((sum, m) => sum + m.count, 0),
  };
}

// Groups branches into one { year, month, count, p50, p85 } entry per
// calendar month present in the data (by closedDate), oldest first. Shared
// building block for the full monthly table (below) and the "as of a given
// instant" baseline lookup (computeCycleTimeBaseline) the KPI card uses —
// both need the same per-month percentiles, just sliced differently.
function groupByCalendarMonth(branches) {
  const byMonth = new Map();
  for (const b of branches) {
    const d = new Date(b.closedDate);
    const key = `${d.getFullYear()}-${d.getMonth()}`;
    if (!byMonth.has(key)) byMonth.set(key, { year: d.getFullYear(), month: d.getMonth(), durations: [] });
    byMonth.get(key).durations.push(b.durationDays);
  }

  return [...byMonth.values()]
    .sort((a, b) => a.year - b.year || a.month - b.month)
    .map(({ year, month, durations }) => {
      const durationsAsc = durations.slice().sort((a, b) => a - b);
      return {
        year,
        month,
        count: durationsAsc.length,
        p50: percentile(durationsAsc, 50),
        p85: percentile(durationsAsc, 85),
      };
    });
}

// Attaches a trailing-baseline comparison (see computeBaseline/
// classifyMonthlyDrift) to a { year, month, count, p50, p85 } month entry,
// given whichever months precede it. Shared by computeMonthlyCycleTimeStats
// (preceding months = the previous rows in its own list) and
// computeCycleTimeBaseline (preceding months = the exact calendar months
// before `now`, looked up by date rather than array position).
function withBaselineComparison(month, precedingMonths) {
  const p50Baseline = computeBaseline(precedingMonths, "p50");
  const p85Baseline = computeBaseline(precedingMonths, "p85");
  return {
    ...month,
    p50Baseline: {
      ...p50Baseline,
      signal: classifyMonthlyDrift({ current: month.p50, baseline: p50Baseline, currentBranchCount: month.count }),
    },
    p85Baseline: {
      ...p85Baseline,
      signal: classifyMonthlyDrift({ current: month.p85, baseline: p85Baseline, currentBranchCount: month.count }),
    },
  };
}

// The `count` calendar months immediately before {year, month}, looked up
// in `monthsByKey` (groupByCalendarMonth's output, keyed the same way) by
// date arithmetic rather than by array position — so a month with zero
// closed branches still counts as an (empty) baseline month instead of
// being silently skipped, the way slicing groupByCalendarMonth's sparse
// output by array index would skip it. Shared by computeMonthlyCycleTimeStats
// and computeCycleTimeBaseline so the monthly table and the KPI card can
// never silently disagree about what "the trailing baseline" means for the
// same month — they used to compute this two different ways (array-slicing
// vs. date lookup), which could quietly diverge whenever a zero-branch
// month fell inside the window. Order doesn't matter: computeBaseline only
// aggregates (mean/median/stdev/sum) over whatever comes back.
function precedingCalendarMonths(monthsByKey, year, month, count) {
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(year, month - (i + 1), 1);
    const key = `${d.getFullYear()}-${d.getMonth()}`;
    return monthsByKey.get(key) ?? { year: d.getFullYear(), month: d.getMonth(), count: 0, p50: null, p85: null };
  });
}

// P50/P85 for every calendar month present in `branches`, oldest first,
// each carrying a comparison against a trailing `BASELINE_WINDOW_MONTHS`
// baseline (mean, median, stdev of the preceding months' values) rather
// than a single-prior-month % change — see the comment on
// BASELINE_WINDOW_MONTHS for why. Covers the whole history in one pass, for
// a month-by-month breakdown table; computeCycleTimeBaseline below answers
// the same question for one specific instant instead.
function computeMonthlyCycleTimeStats(branches) {
  const stats = groupByCalendarMonth(branches);
  const monthsByKey = new Map(stats.map((m) => [`${m.year}-${m.month}`, m]));
  return stats.map((month) =>
    withBaselineComparison(month, precedingCalendarMonths(monthsByKey, month.year, month.month, BASELINE_WINDOW_MONTHS))
  );
}

// Same baseline comparison as computeMonthlyCycleTimeStats's rows, but
// anchored to a specific instant (`now`) rather than "whichever row is
// last in the table" — the KPI card can be showing a past 90-day window
// (paged via the scatter plot's prev/next controls), where "the current
// month" means the month `now` falls in, not today's real calendar month.
function computeCycleTimeBaseline(branches, { now = new Date() } = {}) {
  const monthsByKey = new Map(groupByCalendarMonth(branches).map((m) => [`${m.year}-${m.month}`, m]));
  const key = `${now.getFullYear()}-${now.getMonth()}`;
  const current = monthsByKey.get(key) ?? { year: now.getFullYear(), month: now.getMonth(), count: 0, p50: null, p85: null };
  const precedingMonths = precedingCalendarMonths(monthsByKey, current.year, current.month, BASELINE_WINDOW_MONTHS);
  return withBaselineComparison(current, precedingMonths);
}

// A one-paragraph, plain-language summary of the most recent month, meant
// to sit above the monthly table so a reader gets the "so what" before the
// row-by-row numbers — explicitly framed around not over-reacting to a
// single month's volatility, per the classification in
// classifyMonthlyDrift. Returns null when there's no month to report on.
function describeMonthlyCycleTimeTrend(monthlyStats) {
  const latest = monthlyStats.at(-1);
  if (!latest) return null;

  const monthLabel = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(
    new Date(latest.year, latest.month, 1)
  );

  const p85 = latest.p85Baseline;
  if (p85.signal === "new") {
    return `${monthLabel} is the first month with closed-branch data — nothing to compare it against yet.`;
  }
  if (p85.signal === "low-volume") {
    return (
      `${monthLabel} closed ${latest.count} branch${latest.count === 1 ? "" : "es"} — too few (both this month and ` +
      `in the trailing ${BASELINE_WINDOW_MONTHS}-month baseline) to tell a real trend from ordinary noise.`
    );
  }

  // Absolute day difference, not a %: cycle times are often well under a
  // day, so a tiny, unremarkable move (0.2d -> 0.5d) reports as "+150%" —
  // technically true and practically misleading. "+0.3d" isn't.
  const deltaDays = latest.p85 - p85.mean;
  const direction = deltaDays >= 0 ? "up" : "down";
  const deltaLabel = `${Math.abs(deltaDays).toFixed(1)}d`; // paired with `direction` below, so unsigned
  const baselineLabel = `${p85.mean.toFixed(1)}d mean / ${p85.median.toFixed(1)}d median over the prior ${p85.monthCount} month${p85.monthCount === 1 ? "" : "s"}`;

  if (p85.signal === "stable") {
    return (
      `${monthLabel}'s P85 cycle time (${latest.p85.toFixed(1)}d) is close to its ${BASELINE_WINDOW_MONTHS}-month ` +
      `baseline (${baselineLabel}) — normal month-to-month variation, not a trend change, based on ${latest.count} closed branches.`
    );
  }
  if (p85.signal === "notable") {
    return (
      `${monthLabel}'s P85 cycle time (${latest.p85.toFixed(1)}d) is ${direction} ${deltaLabel} ` +
      `vs. its baseline (${baselineLabel}) — worth keeping an eye on, but on ${latest.count} closed branches it's not yet ` +
      `a clear enough signal to call a trend.`
    );
  }
  return (
    `${monthLabel}'s P85 cycle time (${latest.p85.toFixed(1)}d) is ${direction} ${deltaLabel} ` +
    `vs. its baseline (${baselineLabel}) on ${latest.count} closed branches — large and consistent enough to likely be a real change, not noise.`
  );
}

// "Cleanup events": 2+ long-open branches closed by the *same person* on
// the same calendar day — one person sweeping their own backlog, which
// shows up on the scatter as a spike in P50/P85 that has nothing to do
// with that day's delivery speed. Deliberately scoped per-author, not
// just per-day: two different people each closing one old branch on the
// same day is a coincidence, not a sweep, and would otherwise wrongly tag
// the closer's only-slightly-old branch as "cleanup" alongside someone
// else's actually-old one. A branch counts as an "old" candidate if it
// clears either signal requested by design — the P85 SLA target, or a
// flat day-count floor — since either alone can misfire (a P85 of 2 days
// would flag ordinary branches; a flat floor alone ignores a team whose
// SLA is already 40 days). Candidates are grouped by (local closed-date
// day, author) — matching `formatCleanupEventRange`'s day formatting
// below; a group only becomes a reported "event" once it reaches
// `minClusterSize` candidates — below that it's just one slow branch
// closing, not a sweep, and calling it out would cry wolf on ordinary
// noise.
//
// OR clause: any calendar day on which more than `dayClosedThreshold`
// *old* branches (same age/P85 test as above) were closed, by anyone, is also
// a cleanup day, and each of those old branches counts as cleanup — a bulk
// sweep that size isn't delivery speed either. Young branches closed that day
// are left alone. Such a day replaces any per-author cluster that
// would have been reported for the same day, so no branch is double-counted.
const CLEANUP_AGE_THRESHOLD_DAYS = 25;
const CLEANUP_MIN_CLUSTER_SIZE = 2;
const CLEANUP_DAY_CLOSED_THRESHOLD = 5;

function detectCleanupEvents(branches, {
  p85 = null,
  ageThresholdDays = CLEANUP_AGE_THRESHOLD_DAYS,
  minClusterSize = CLEANUP_MIN_CLUSTER_SIZE,
  dayClosedThreshold = CLEANUP_DAY_CLOSED_THRESHOLD,
} = {}) {
  const candidates = branches
    .filter((b) => b.durationDays > ageThresholdDays || (p85 != null && b.durationDays > p85))
    .map((b) => ({ ...b, closedAtMs: new Date(b.closedDate).getTime() }));

  const byDay = new Map();
  for (const b of candidates) {
    const dayKey = new Date(b.closedAtMs).toDateString();
    if (!byDay.has(dayKey)) byDay.set(dayKey, []);
    byDay.get(dayKey).push(b);
  }
  const busyDays = new Set();
  const busyDayClusters = [];
  for (const [dayKey, dayBranches] of byDay) {
    if (dayBranches.length > dayClosedThreshold) {
      busyDays.add(dayKey);
      busyDayClusters.push(dayBranches);
    }
  }

  const byDayAndAuthor = new Map();
  for (const b of candidates) {
    const dayKey = new Date(b.closedAtMs).toDateString();
    if (busyDays.has(dayKey)) continue;
    const groupKey = `${dayKey}|${b.authorHandle ?? "unknown"}`;
    if (!byDayAndAuthor.has(groupKey)) byDayAndAuthor.set(groupKey, []);
    byDayAndAuthor.get(groupKey).push(b);
  }

  return [
    ...[...byDayAndAuthor.values()].filter((cluster) => cluster.length >= minClusterSize),
    ...busyDayClusters,
  ]
    .map((cluster) => cluster.slice().sort((a, b) => a.closedAtMs - b.closedAtMs))
    .sort((a, b) => a[0].closedAtMs - b[0].closedAtMs)
    .map((cluster) => ({
      startDate: new Date(cluster[0].closedAtMs).toISOString(),
      endDate: new Date(cluster[cluster.length - 1].closedAtMs).toISOString(),
      count: cluster.length,
      medianAgeDays: median(cluster.map((b) => b.durationDays)),
      branchKeys: new Set(cluster.map((b) => b.branchId ?? b.name)),
    }));
}

// Every branch key involved in any detected cleanup event, flattened into
// one lookup set — shared by the chart's per-point styling and the
// "exclude cleanup outliers" metrics toggle, so the two can never disagree
// about which branches count as cleanup.
function cleanupBranchKeySet(cleanupEvents) {
  const keys = new Set();
  for (const event of cleanupEvents) for (const key of event.branchKeys) keys.add(key);
  return keys;
}
