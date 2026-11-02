// Cycle Time Scatter Plot — one point per branch, X = close date, Y = how
// long it took to close, with a KPI summary card and several analytical
// overlays (30-day rolling P50/P85, a linear trendline, monthly background
// banding, outlier highlighting). Vanilla JS + Chart.js, matching this
// dashboard's stack (see app.js) — no extra dependencies. The actual math
// lives in cycle-time-math.js, loaded before this file; this file is purely
// presentation (Chart.js config + DOM rendering).
//
// Input: { name, createdDate, closedDate (ISO strings), durationDays, authorHandle }[]
// — closedDate drives x-position/windowing/bucketing everywhere (including
// in cycle-time-math.js); createdDate is carried through only for display,
// in the tooltip.
// Usage: createCycleTimeScatterPlot({ canvas, legendEl, kpiEl, calloutEl, branches, metricsBranches, rollingBranches, baselineBranches, cleanupEvents, excludingCleanup, windowStart, now })

// A branch within the P85 target uses the theme's own ink color (white on
// dark, near-black on light) rather than a fixed hue — computed at chart
// creation time below, since it depends on the current theme.
const CYCLE_TIME_HOVER_COLOR = "#fcd34d"; // amber-300
const CYCLE_TIME_OUTLIER_COLOR = "#ef4444"; // red-500 — matches the P85 line: a dot past it renders in the same color
const CYCLE_TIME_OUTLIER_HOVER_COLOR = "#fca5a5"; // red-300
const CYCLE_TIME_MEDIAN_COLOR = "#22c55e"; // green-500
const CYCLE_TIME_P85_COLOR = "#ef4444"; // red-500
const CYCLE_TIME_TREND_COLOR = "#60a5fa"; // blue-400 — unused elsewhere in this dashboard, so it can't be confused with the P50/P85 family
const CYCLE_TIME_CLEANUP_COLOR = "#a78bfa"; // violet-400 — reserved for "cleanup event" branches (see cycle-time-math.js's detectCleanupEvents), so a bulk-close spike reads as deliberate debt cleanup rather than a bottleneck

const cycleTimeAxisDateFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const cycleTimeTooltipDateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const cycleTimeCleanupDateFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

// "on Mar 4" — detectCleanupEvents groups by calendar day, so an event's
// startDate/endDate always fall on the same day; only `startDate` matters.
function formatCleanupEventRange(event) {
  return `on ${cycleTimeCleanupDateFmt.format(new Date(event.startDate))}`;
}

function withAlpha(hex, alpha) {
  const n = parseInt(hex.replace("#", ""), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// The y-axis's breakpoint/rate settings, shared between the scale options
// below and cycleTimeAboveRateFor's rate math — they have to agree, since
// that math exists purely to make the two bands actually fit inside a
// *fixed* container height (CYCLE_TIME_CHART_TOTAL_HEIGHT_PX), whatever
// the window's max duration turns out to be.
const CYCLE_TIME_Y_BREAKPOINT = 5;
// The 0-5d band's height is a flat constant, deliberately never scaled by
// the data — a broad-history window (a year-old backfill spike included)
// has a much bigger max than a quiet recent 90-day one, but that's a
// property of the *long tail*, not of "how many days are in the first
// band" (always exactly 5, by definition). This value was picked by eye
// against real data as "clearly roomier than a plain axis," same bar the
// original "double the vertical space" ask was judged against.
const CYCLE_TIME_LOW_BAND_HEIGHT_PX = 175;
// Rough estimate of the vertical space Chart.js's own layout (x-axis
// ticks + title, a hair of default padding) takes up outside the actual
// plotting area — the fixed total height below has to leave room for
// this on top of the two bands, or that chrome would eat into the low
// band's promised 175px instead of sitting outside it.
const CYCLE_TIME_CHART_CHROME_PX = 55;
// The container's total height never changes — pagination/toggling would
// otherwise jump the chart's size around from window to window, which
// reads as janky regardless of how "correct" the per-band math is. Chosen
// to match how the chart already looked for a typical 90-day window
// before this was made a hard constant.
const CYCLE_TIME_CHART_TOTAL_HEIGHT_PX = 520;
// Whatever's left of the fixed total height once the chrome and the low
// band's own constant have taken their share — this, not any rate, is
// the actual constant; the band above the breakpoint always renders in
// exactly this many pixels, however many days it has to cover.
const CYCLE_TIME_ABOVE_BREAKPOINT_HEIGHT_PX =
  CYCLE_TIME_CHART_TOTAL_HEIGHT_PX - CYCLE_TIME_CHART_CHROME_PX - CYCLE_TIME_LOW_BAND_HEIGHT_PX;

// The pixels-per-day rate that makes the band above the breakpoint fit
// exactly within CYCLE_TIME_ABOVE_BREAKPOINT_HEIGHT_PX for this window's
// actual max duration — this is the one thing that adapts: a window with
// a longer tail gets a lower (more compressed) rate, a quieter one gets a
// higher (more spread out) rate, so the *pixels*, not the density, stay
// fixed.
function cycleTimeAboveRateFor(maxDuration) {
  const daysAboveBreakpoint = Math.max(maxDuration - CYCLE_TIME_Y_BREAKPOINT, 1e-6); // guard divide-by-zero when max <= breakpoint
  return CYCLE_TIME_ABOVE_BREAKPOINT_HEIGHT_PX / daysAboveBreakpoint;
}

// A linear y-axis puts most of this dataset's durations (typically a few
// days) into a thin sliver near the bottom, with the handful of long-running
// outliers stretching the axis out above them. This scale keeps values
// linear within two separate bands — [0, breakpoint] and [breakpoint, max]
// — but gives each band its own rate (pixels per day), so the dense
// low-duration cluster gets a constant, generous amount of room regardless
// of how far the long tail above it stretches. Values passed in as
// `belowRate`/`aboveRate` are chosen so that "1 weight unit" is exactly
// "1 pixel" against the chart's fixed container height — this class
// itself doesn't know or care about that; it just maps value <-> weight
// linearly within each band. Registered once, globally, as a new scale
// type (Chart.js has no built-in for this); `min` must be 0 for the pixel
// math below to hold, same as the hard floor already set on the y-axis
// options.
(function registerCycleTimeExpandedScale() {
  if (Chart.registry.scales.get("cycleTimeExpandedLinear")) return; // survives hot reloads / repeated script loads

  class CycleTimeExpandedLinearScale extends Chart.LinearScale {
    get breakpoint() {
      return this.options.breakpoint ?? 30;
    }
    get belowRate() {
      return this.options.belowRate ?? 3;
    }
    get aboveRate() {
      return this.options.aboveRate ?? 1;
    }

    // "Weight" is the value's position on an internal axis where the
    // [0, breakpoint] segment and the (breakpoint, max] segment each grow
    // at their own rate — equal steps in weight-space are NOT equal steps
    // in value-space across the two bands, which is exactly the point.
    _weightForValue(value) {
      const { breakpoint, belowRate, aboveRate } = this;
      return value <= breakpoint ? value * belowRate : breakpoint * belowRate + (value - breakpoint) * aboveRate;
    }

    _valueForWeight(weight) {
      const { breakpoint, belowRate, aboveRate } = this;
      const capWeight = breakpoint * belowRate;
      return weight <= capWeight ? weight / belowRate : breakpoint + (weight - capWeight) / aboveRate;
    }

    _totalWeight() {
      return this._weightForValue(this.max) || 1; // guard divide-by-zero when max is 0
    }

    // Chart.js's own Scale#configure() already sets up _startPixel/
    // _reversePixels to handle the vertical-axis flip (low value at the
    // bottom) — getPixelForDecimal applies that internally, so this just
    // needs to hand it a plain 0..1 decimal, not flip it again.
    getPixelForValue(value) {
      const decimal = this._weightForValue(value) / this._totalWeight();
      return this.getPixelForDecimal(decimal);
    }

    getValueForPixel(pixel) {
      const decimal = this.getDecimalForPixel(pixel);
      return this._valueForWeight(decimal * this._totalWeight());
    }

    // Ticks are generated directly in value-space (not by dividing the
    // weighted axis into equal steps, which would land on ugly non-round
    // numbers) — dense round steps below the breakpoint, sparser ones above.
    buildTicks() {
      const { breakpoint } = this;
      const max = this.max;
      const belowStep = breakpoint > 0 ? niceStep(breakpoint, 6) : 0;
      const ticks = [];
      if (belowStep > 0) {
        for (let v = 0; v <= Math.min(breakpoint, max); v += belowStep) ticks.push({ value: v });
      } else {
        ticks.push({ value: 0 });
      }

      const aboveRange = max - breakpoint;
      if (aboveRange > 0) {
        const aboveStep = niceStep(aboveRange, 4);
        for (let v = breakpoint + aboveStep; v <= max + 1e-6; v += aboveStep) {
          ticks.push({ value: Math.round(v * 10) / 10 });
        }
      }

      return ticks;
    }
  }

  // A "nice" round step (1/2/5 × a power of 10) that fits roughly
  // `targetCount` steps across `range`.
  function niceStep(range, targetCount) {
    if (range <= 0) return 0;
    const rough = range / targetCount;
    const magnitude = Math.pow(10, Math.floor(Math.log10(rough)));
    const normalized = rough / magnitude;
    const nice = normalized < 1.5 ? 1 : normalized < 3 ? 2 : normalized < 7 ? 5 : 10;
    return nice * magnitude;
  }

  CycleTimeExpandedLinearScale.id = "cycleTimeExpandedLinear";
  CycleTimeExpandedLinearScale.defaults = Chart.LinearScale.defaults;
  Chart.register(CycleTimeExpandedLinearScale);
})();

// Draws dashed guide lines from the hovered branch point down to the x-axis
// and across to the y-axis — Chart.js has no built-in for this, so it's a
// small scoped plugin (registered per-chart via the `plugins` array below,
// not globally) reading the chart's own hover state each frame.
function makeCrosshairPlugin(lineColor) {
  return {
    id: "cycleTimeCrosshair",
    afterDatasetsDraw(chart) {
      const active = chart.getActiveElements();
      const point = active.find((el) => el.datasetIndex === 0);
      if (!point) return;

      const { x, y } = point.element;
      const { chartArea, ctx } = chart;

      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1;
      ctx.strokeStyle = lineColor;

      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x, chartArea.bottom);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(chartArea.left, y);
      ctx.lineTo(x, y);
      ctx.stroke();

      ctx.restore();
    },
  };
}

// Alternating subtle vertical bands, one per calendar month, drawn behind
// the datasets so the continuous timeline underneath isn't broken up.
function makeMonthBandingPlugin(bandColor) {
  return {
    id: "cycleTimeMonthBanding",
    beforeDatasetsDraw(chart) {
      const { ctx, chartArea, scales } = chart;
      const xScale = scales.x;
      if (!chartArea || !xScale || xScale.min == null || xScale.max == null) return;

      const rangeStart = new Date(xScale.min);
      const rangeEnd = new Date(xScale.max);
      let monthStart = new Date(rangeStart.getFullYear(), rangeStart.getMonth(), 1);
      let bandIndex = 0;

      ctx.save();
      while (monthStart.getTime() < rangeEnd.getTime()) {
        const monthEnd = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 1);
        if (bandIndex % 2 === 1) {
          const xStart = xScale.getPixelForValue(Math.max(monthStart.getTime(), xScale.min));
          const xEnd = xScale.getPixelForValue(Math.min(monthEnd.getTime(), xScale.max));
          ctx.fillStyle = bandColor;
          ctx.fillRect(xStart, chartArea.top, xEnd - xStart, chartArea.bottom - chartArea.top);
        }
        monthStart = monthEnd;
        bandIndex++;
      }
      ctx.restore();
    },
  };
}

// Light shaded bands + a small "Cleanup" label along the date axis for each
// detected cleanup event (see detectCleanupEvents in cycle-time-math.js) —
// the chart-level context for why the dots inside the band are hollow.
// Every event is a single calendar day (see detectCleanupEvents), so each
// gets half a day of padding on each side purely to give the band some
// visible width.
function makeCleanupEventBandsPlugin(events, { bandColor, labelColor }) {
  const padMs = 43200000; // 12h
  return {
    id: "cycleTimeCleanupBands",
    beforeDatasetsDraw(chart) {
      const { ctx, chartArea, scales } = chart;
      const xScale = scales.x;
      if (!chartArea || !xScale || xScale.min == null || xScale.max == null || events.length === 0) return;

      ctx.save();
      for (const event of events) {
        const bandStartMs = Math.max(xScale.min, new Date(event.startDate).getTime() - padMs);
        const bandEndMs = Math.min(xScale.max, new Date(event.endDate).getTime() + padMs);
        if (bandEndMs <= xScale.min || bandStartMs >= xScale.max) continue;

        const xStart = xScale.getPixelForValue(bandStartMs);
        const xEnd = xScale.getPixelForValue(bandEndMs);
        ctx.fillStyle = bandColor;
        ctx.fillRect(xStart, chartArea.top, Math.max(xEnd - xStart, 2), chartArea.bottom - chartArea.top);
      }
      ctx.restore();
    },
    afterDatasetsDraw(chart) {
      const { ctx, chartArea, scales } = chart;
      const xScale = scales.x;
      if (!chartArea || !xScale || xScale.min == null || xScale.max == null || events.length === 0) return;

      ctx.save();
      ctx.font = "10px sans-serif";
      ctx.fillStyle = labelColor;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      for (const event of events) {
        const midMs = (new Date(event.startDate).getTime() + new Date(event.endDate).getTime()) / 2;
        if (midMs < xScale.min || midMs > xScale.max) continue;
        ctx.fillText("Cleanup", xScale.getPixelForValue(midMs), chartArea.top + 2);
      }
      ctx.restore();
    },
  };
}

// One row per metric — the legend swatch and its plain-language explanation
// live side by side, rather than as two separately-positioned blocks, so
// there's no ambiguity about which description belongs to which line/dot.
function renderCycleTimeMetricLegend(legendEl, { median, p85, pointColor, hasCleanupEvents }) {
  if (!legendEl) return;

  const rows = [
    {
      swatch: `<span class="legend-dot" style="background:${pointColor}"></span>`,
      label: "Branch",
      description: "One dot per closed branch. Hover a dot to see its name, closed date, created date, and duration.",
    },
    {
      swatch: `<span class="legend-dot" style="background:${CYCLE_TIME_OUTLIER_COLOR}"></span>`,
      label: "Exceeds P85 target",
      description: "This branch took longer to close than the P85 threshold below.",
    },
    ...(hasCleanupEvents
      ? [
          {
            swatch: `<span class="legend-dot legend-dot-hollow" style="border-color:${CYCLE_TIME_CLEANUP_COLOR}"></span>`,
            label: "Cleanup / backlog resolution",
            description:
              "Part of a detected bulk-close: 2+ long-open branches closed the same day. Shown hollow, with a shaded band on the axis, so a spike here reads as planned debt cleanup rather than a drop in delivery speed.",
          },
        ]
      : []),
    {
      swatch: `<span class="legend-dash legend-dash-solid" style="border-top-color:${CYCLE_TIME_MEDIAN_COLOR}"></span>`,
      label: `90 days Median (p50) — ${median.toFixed(1)}d`,
      description: "It shows the typical speed. Half of closed branches merge faster than this, half slower.",
    },
    {
      swatch: `<span class="legend-dash legend-dash-solid" style="border-top-color:${CYCLE_TIME_P85_COLOR}"></span>`,
      label: `90 days SLA (p85) — ${p85.toFixed(1)}d`,
      description: "The operational target: 85% of branches merge within this time. Anything above is considered too slow for our standards and counts as a bad delay or bottleneck.",
    },
    {
      swatch: `<span class="legend-dash" style="border-top-color:${CYCLE_TIME_MEDIAN_COLOR}"></span>`,
      label: "30 days rolling p50",
      description: "The 50th-percentile duration among branches closed in the trailing 30 days. It tracks how your typical speed changes over time.",
    },
    {
      swatch: `<span class="legend-dash" style="border-top-color:${CYCLE_TIME_P85_COLOR}"></span>`,
      label: "30 days rolling p85",
      description: "The 85th-percentile duration among branches closed in the trailing 30 days. Tracks how your worst delays change over time. If it goes up, your team is getting stuck in bottlenecks more often.",
    },
    {
      swatch: `<span class="legend-dash legend-dash-solid" style="border-top-color:${CYCLE_TIME_TREND_COLOR}"></span>`,
      label: "Trend",
      description: `Best-fit line across every branch — shows whether cycle times are trending up or down overall. While the red line (P85) wiggles up and down based on temporary bad days, the blue linear regression line ignores short-term noise to answer one simple question: "Is our system getting faster or slower overall over these 90 days?"`,
    },
  ];

  legendEl.innerHTML = rows
    .map(
      (row) => `
      <div class="metric-legend-row">
        <span class="legend-item">${row.swatch}${row.label}</span>
        <p class="metric-legend-desc">${row.description}</p>
      </div>`
    )
    .join("");
}

// Three KPI tiles: current P50, current P85, and P85's month-over-month
// change (colored — a shrinking P85 is the win, so it renders green; a
// growing one renders in the same orange used for "attention" elsewhere in
// this dashboard, e.g. the Jira domain).
//
const cycleTimeMonthLabelFmt = new Intl.DateTimeFormat(undefined, { month: "short", year: "numeric" });

// Renders a month's value against its trailing-baseline comparison (see
// classifyMonthlyDrift in cycle-time-math.js), shared by the KPI card and
// the monthly table so the two never disagree on what "improving" looks
// like. Shows the *absolute* day difference rather than a percentage —
// cycle times are often well under a day, so a tiny, unremarkable move
// (0.2d -> 0.5d) reports as "+150%" on a percentage scale, which reads as
// far more dramatic than it is. Only "drift" — a change large and
// well-supported enough to likely be real — gets colored; "notable" gets
// the same arrow/Δ text but stays neutral on purpose, so a merely
// worth-watching month doesn't visually shout the same as a confirmed one;
// "stable"/"low-volume"/"new" skip the number entirely, since with too
// little data (or too small a gap) the number itself is more likely to
// mislead than inform.
function formatBaselineBadge(current, baseline) {
  if (baseline.signal === "new") return { label: "New", className: "", title: "No prior months to compare against yet." };
  if (baseline.signal === "low-volume") {
    return {
      label: "Low volume",
      className: "",
      title: `Only ${baseline.branchCount} branch(es) across the baseline window and/or this month — too few to trust a percentile.`,
    };
  }

  const delta = current - baseline.mean;
  const rounded = Math.round(delta * 10) / 10;
  const improving = rounded <= 0;
  const arrow = improving ? "▼ " : "▲ ";
  const sign = rounded > 0 ? "+" : "";
  const deltaLabel = `${arrow}${sign}${rounded}d`;
  const title =
    `${baseline.monthCount}-month baseline: ${baseline.mean.toFixed(1)}d mean / ${baseline.median.toFixed(1)}d median` +
    (baseline.stdev != null ? ` (σ ${baseline.stdev.toFixed(1)}d)` : "") +
    `, ${baseline.branchCount} branches.`;

  if (baseline.signal === "stable") return { label: `${deltaLabel} · Stable`, className: "", title };
  if (baseline.signal === "notable") return { label: `${deltaLabel} · Watch`, className: "", title };
  return { label: `${deltaLabel} · Drift`, className: improving ? "kpi-delta-good" : "kpi-delta-bad", title };
}

// `baseline` is computeCycleTimeBaseline's output for whatever instant the
// scatter plot is currently anchored to (real "now", or a past window's end
// date if the user has paged backward) — same baseline comparison the
// monthly table uses, just for one specific month instead of every row.
function renderCycleTimeKpiCard(kpiEl, { p50, p85, baseline }) {
  if (!kpiEl) return;

  const p50Label = p50 != null ? `${p50.toFixed(1)}d` : "—";
  const p85Label = p85 != null ? `${p85.toFixed(1)}d` : "—";

  const p85Badge = formatBaselineBadge(baseline.p85, baseline.p85Baseline);
  const baselineSubLabel =
    baseline.p85Baseline.signal === "new" || baseline.p85Baseline.signal === "low-volume"
      ? p85Badge.title
      : `${baseline.p85Baseline.mean.toFixed(1)}d baseline → ${baseline.p85.toFixed(1)}d this month`;

  kpiEl.innerHTML = `
    <div class="tile" data-accent="figma">
      <p class="tile-label">P50 cycle time</p>
      <p class="kpi-value">${p50Label}</p>
    </div>
    <div class="tile" data-accent="figma">
      <p class="tile-label">P85 cycle time</p>
      <p class="kpi-value">${p85Label}</p>
    </div>
    <div class="tile" data-accent="figma">
      <p class="tile-label">P85 vs. 3-mo baseline</p>
      <p class="kpi-value ${p85Badge.className}" title="${escapeHtml(p85Badge.title)}">${p85Badge.label}</p>
      <p class="kpi-delta">${baselineSubLabel}</p>
    </div>
  `;
}

// Month-by-month P50/P85 breakdown, most recent month first — unlike the
// KPI card (which is scoped to whatever 90-day window app.js is currently
// showing), this always covers every closed branch ever seen, since the
// whole point is a longitudinal view a single window can't give you. Each
// value is compared against a trailing multi-month baseline rather than
// the single prior month — see BASELINE_WINDOW_MONTHS in cycle-time-math.js
// for why a one-month comparison is too noisy to trust here.
// `monthlyStats` is computeMonthlyCycleTimeStats's output.
function renderCycleTimeMonthlyTable(tableEl, monthlyStats) {
  if (!tableEl) return;

  if (monthlyStats.length === 0) {
    tableEl.innerHTML = `<p class="branch-empty">No closed branches yet.</p>`;
    return;
  }

  const summary = describeMonthlyCycleTimeTrend(monthlyStats);

  const rows = [...monthlyStats]
    .reverse()
    .map((m) => {
      const p50Badge = formatBaselineBadge(m.p50, m.p50Baseline);
      const p85Badge = formatBaselineBadge(m.p85, m.p85Baseline);
      return `
        <tr>
          <td>${cycleTimeMonthLabelFmt.format(new Date(m.year, m.month, 1))}</td>
          <td>${m.p50 != null ? `${m.p50.toFixed(1)}d` : "—"} <span class="monthly-table-delta ${p50Badge.className}" title="${escapeHtml(p50Badge.title)}">${p50Badge.label}</span></td>
          <td>${m.p85 != null ? `${m.p85.toFixed(1)}d` : "—"} <span class="monthly-table-delta ${p85Badge.className}" title="${escapeHtml(p85Badge.title)}">${p85Badge.label}</span></td>
          <td>${m.count}</td>
        </tr>`;
    })
    .join("");

  tableEl.innerHTML = `
    ${summary ? `<div class="banner banner-note" role="note"><span class="banner-icon" aria-hidden="true">◆</span><p>${escapeHtml(summary)}</p></div>` : ""}
    <table class="monthly-table">
      <thead>
        <tr>
          <th>Month</th>
          <th>P50</th>
          <th>P85</th>
          <th>Branches</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

// One callout banner per detected cleanup event that overlaps the visible
// window (`events` is already pre-filtered to that by the caller) —
// "Spike on [date] driven by clearance of N long-standing branches",
// rendered directly under the chart so a reader hits it right after
// spotting the spike, before the legend or monthly table below.
// `excludingCleanup` just appends a note that these branches are
// currently excluded from the KPI tiles above, so the banner doesn't
// contradict what the KPI card/trendline are actually showing.
function renderCycleTimeCleanupBanner(calloutEl, events, { excludingCleanup }) {
  if (!calloutEl) return;
  if (events.length === 0) {
    calloutEl.innerHTML = "";
    return;
  }

  calloutEl.innerHTML = events
    .map((event) => {
      const text =
        `Spike ${formatCleanupEventRange(event)} driven by clearance of ${event.count} long-standing ` +
        `branch${event.count === 1 ? "" : "es"} (median ${event.medianAgeDays.toFixed(0)}d open) — ` +
        `backlog cleanup, not a drop in delivery speed.` +
        (excludingCleanup ? " Excluded from the metrics on top." : "");
      return `<div class="banner banner-note cleanup-banner" role="note"><span class="banner-icon" aria-hidden="true">◆</span><p>${escapeHtml(text)}</p></div>`;
    })
    .join("");
}

// `canvas`: a <canvas> element (wrap it in a sized container per the
// Chart.js/responsive gotcha noted in CLAUDE.md). `legendEl`, `kpiEl`,
// `calloutEl`: optional elements filled with the per-metric legend/
// description rows, the KPI summary card, and the cleanup-event callout
// banner(s), respectively. `branches`: the input array described above,
// already scoped to whatever window the caller wants plotted (e.g. app.js
// passes a 90-day slice, paged via its own nav controls) — this is always
// the *full* set of dots to draw, including any flagged as cleanup events,
// so a spike's context stays visible on the chart even when it's excluded
// from the KPI tiles above. `metricsBranches` (defaults to `branches`) is
// what the P50/P85 summary lines, outlier threshold, and trendline are
// actually computed from — pass a cleanup-filtered subset here (and to
// `rollingBranches`/`baselineBranches` below) to implement the "exclude
// cleanup outliers from metrics" toggle — the dots themselves are
// unaffected, so the chart keeps showing where the spike came from even
// while the numbers around it stop counting it. `rollingBranches`:
// optional, defaults to `metricsBranches` — pass a superset that also
// includes some lookback *before* the window (app.js adds 30 days) so the
// 30-day rolling P50/P85 has a full trailing window even at the start of
// the visible range, instead of understating it purely because of where
// the window boundary happens to land. `windowStart`: required if
// `rollingBranches` extends earlier than `branches` — trims the resulting
// rolling curve back to the visible window (the lookback is only there to
// inform the calculation, not to extend what gets drawn).
// `baselineBranches`: optional, defaults to `metricsBranches` — pass the
// *full*, un-windowed dataset instead (app.js does), since a 90-day window
// can't reliably contain a full trailing 3-month baseline for the KPI
// card's comparison. `cleanupEvents`: pre-detected cleanup events (see
// detectCleanupEvents in cycle-time-math.js) that overlap this window —
// used to style/tooltip the matching dots, draw the axis bands, and render
// `calloutEl`'s banner(s); pass `[]` (the default) to disable the feature
// entirely. `excludingCleanup`: whether the caller built `metricsBranches`
// etc. by excluding cleanup branches — purely cosmetic, just changes the
// callout banner's wording. `now`: the "current" instant the KPI card's
// baseline comparison is relative to — defaults to the real current time,
// but a caller paging through past windows should pass that window's own
// end date instead, or "this month" would always mean the real current
// month regardless of which window is being viewed. Returns the Chart.js
// instance (destroy it yourself before re-creating, same as the other
// charts in app.js).
function createCycleTimeScatterPlot({
  canvas,
  legendEl,
  kpiEl,
  calloutEl,
  branches,
  metricsBranches = branches,
  rollingBranches = metricsBranches,
  baselineBranches = metricsBranches,
  cleanupEvents = [],
  excludingCleanup = false,
  windowStart,
  now = new Date(),
}) {
  const cleanupKeys = cleanupBranchKeySet(cleanupEvents);
  const points = branches.map((b) => ({
    x: new Date(b.closedDate).getTime(),
    y: b.durationDays,
    name: b.name,
    createdDate: b.createdDate,
    closedDate: b.closedDate,
    authorHandle: b.authorHandle,
    isCleanupEvent: cleanupKeys.has(b.branchId ?? b.name),
  }));

  const { p50: median, p85 } = computeCycleTimeSummary(metricsBranches);
  const rollingSamples = computeRollingPercentiles(rollingBranches, { windowDays: 30, stepDays: 1 }).filter(
    (s) => windowStart == null || s.date >= windowStart.getTime()
  );
  const regression = computeLinearRegression(metricsBranches);
  // Deliberately from `baselineBranches` (the full, un-windowed dataset),
  // not `metricsBranches` — a 90-day window barely spans 3 calendar months
  // itself, so it can't reliably supply a full trailing 3-month baseline
  // for whichever month `now` falls in.
  const baseline = computeCycleTimeBaseline(baselineBranches, { now });

  const xs = points.map((p) => p.x);
  const minX = xs.length ? Math.min(...xs) : Date.now() - 30 * 86400000;
  const maxX = xs.length ? Math.max(...xs) : Date.now();

  const rollingP50Data = rollingSamples.filter((s) => s.p50 != null).map((s) => ({ x: s.date, y: s.p50 }));
  const rollingP85Data = rollingSamples.filter((s) => s.p85 != null).map((s) => ({ x: s.date, y: s.p85 }));
  const trendData = [
    { x: minX, y: regression.predict(minX) },
    { x: maxX, y: regression.predict(maxX) },
  ];

  // Read before rendering the legend — the branch dot color follows the
  // theme (white on dark, near-black on light, same as body text) rather
  // than being a fixed color, so the legend swatch needs it too.
  const muted = getComputedStyle(document.documentElement).getPropertyValue("--ink-muted").trim();
  const gridline = getComputedStyle(document.documentElement).getPropertyValue("--gridline").trim();
  const surface = getComputedStyle(document.documentElement).getPropertyValue("--surface").trim();
  const border = getComputedStyle(document.documentElement).getPropertyValue("--border").trim();
  const ink = getComputedStyle(document.documentElement).getPropertyValue("--ink").trim();
  const monthBandColor = withAlpha(ink, 0.05);
  const cleanupBandColor = withAlpha(CYCLE_TIME_CLEANUP_COLOR, 0.12);

  renderCycleTimeMetricLegend(legendEl, { median, p85, pointColor: ink, hasCleanupEvents: cleanupEvents.length > 0 });
  renderCycleTimeKpiCard(kpiEl, { p50: median, p85, baseline });
  renderCycleTimeCleanupBanner(calloutEl, cleanupEvents, { excludingCleanup });

  // The container's height is a fixed constant (.chart-box-cycle-time in
  // style.css) — only the *rate* for the band above the breakpoint
  // changes per render, recomputed from this window's actual max duration
  // so that band still fits inside its fixed pixel allowance
  // (CYCLE_TIME_ABOVE_BREAKPOINT_HEIGHT_PX) instead of pushing the chart
  // taller or shorter every time the user pages or the toggle changes.
  const maxDuration = points.length ? Math.max(...points.map((p) => p.y)) : 0;
  const cycleTimeAboveRate = cycleTimeAboveRateFor(maxDuration);

  return new Chart(canvas, {
    plugins: [
      makeMonthBandingPlugin(monthBandColor),
      makeCleanupEventBandsPlugin(cleanupEvents, { bandColor: cleanupBandColor, labelColor: CYCLE_TIME_CLEANUP_COLOR }),
      makeCrosshairPlugin(muted),
    ],
    data: {
      datasets: [
        {
          type: "scatter",
          label: "Branches",
          data: points,
          pointRadius: 4.5,
          pointHoverRadius: 7,
          pointBackgroundColor: (ctx) => (ctx.raw?.isCleanupEvent ? "transparent" : ctx.raw?.y > p85 ? CYCLE_TIME_OUTLIER_COLOR : ink),
          pointBorderColor: (ctx) => (ctx.raw?.isCleanupEvent ? CYCLE_TIME_CLEANUP_COLOR : "transparent"),
          pointBorderWidth: (ctx) => (ctx.raw?.isCleanupEvent ? 2 : 0),
          pointHoverBackgroundColor: (ctx) =>
            ctx.raw?.isCleanupEvent
              ? withAlpha(CYCLE_TIME_CLEANUP_COLOR, 0.35)
              : ctx.raw?.y > p85
                ? CYCLE_TIME_OUTLIER_HOVER_COLOR
                : CYCLE_TIME_HOVER_COLOR,
          pointHoverBorderColor: (ctx) => (ctx.raw?.isCleanupEvent ? CYCLE_TIME_CLEANUP_COLOR : "#fff"),
          pointHoverBorderWidth: 1.5,
        },
        {
          type: "line",
          label: "Median (p50)",
          data: [
            { x: minX, y: median },
            { x: maxX, y: median },
          ],
          borderColor: CYCLE_TIME_MEDIAN_COLOR,
          borderWidth: 1.5,
          pointRadius: 0,
          pointHitRadius: 0,
          fill: false,
        },
        {
          type: "line",
          label: "p85 SLA",
          data: [
            { x: minX, y: p85 },
            { x: maxX, y: p85 },
          ],
          borderColor: CYCLE_TIME_P85_COLOR,
          borderWidth: 1.5,
          pointRadius: 0,
          pointHitRadius: 0,
          fill: false,
        },
        {
          type: "line",
          label: "30d rolling p50",
          data: rollingP50Data,
          borderColor: CYCLE_TIME_MEDIAN_COLOR,
          borderDash: [6, 4],
          borderWidth: 1.5,
          tension: 0.3,
          pointRadius: 0,
          pointHitRadius: 0,
          fill: false,
        },
        {
          type: "line",
          label: "30d rolling p85",
          data: rollingP85Data,
          borderColor: CYCLE_TIME_P85_COLOR,
          borderDash: [6, 4],
          borderWidth: 1.5,
          tension: 0.3,
          pointRadius: 0,
          pointHitRadius: 0,
          fill: false,
        },
        {
          type: "line",
          label: "Trend (linear fit)",
          data: trendData,
          borderColor: CYCLE_TIME_TREND_COLOR,
          borderWidth: 2,
          pointRadius: 0,
          pointHitRadius: 0,
          fill: false,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "nearest", intersect: true },
      plugins: {
        legend: { display: false },
        tooltip: {
          // Only the scatter dataset (index 0) carries per-branch detail —
          // the reference/overlay-line datasets shouldn't get their own tooltip.
          filter: (item) => item.datasetIndex === 0,
          backgroundColor: surface,
          borderColor: border,
          borderWidth: 1,
          titleColor: ink,
          bodyColor: muted,
          padding: 10,
          boxPadding: 4,
          cornerRadius: 8,
          displayColors: false,
          callbacks: {
            title: (items) => items[0]?.raw?.name ?? "",
            label: (item) => {
              const point = item.raw;
              return [
                `Author: ${point.authorHandle ?? "Unknown"}`,
                ...(point.isCleanupEvent ? ["Type: Cleanup / Backlog Resolution"] : []),
                `Closed: ${cycleTimeTooltipDateFmt.format(new Date(point.closedDate))}`,
                `Duration: ${point.y.toFixed(1)}d${point.y > p85 ? " (exceeds P85 target)" : ""}`,
                `Created: ${cycleTimeTooltipDateFmt.format(new Date(point.createdDate))}`,
              ];
            },
          },
        },
      },
      scales: {
        x: {
          type: "linear",
          title: { display: true, text: "Closed", color: muted, font: { size: 10 } },
          grid: { display: false },
          ticks: {
            color: muted,
            font: { size: 10 },
            callback: (value) => cycleTimeAxisDateFmt.format(new Date(value)),
          },
        },
        y: {
          type: "cycleTimeExpandedLinear",
          // The 0-5 day band gets a flat, generous pixel budget regardless
          // of the window's data — that's where almost every branch lands,
          // and a plain linear axis crushes it into a sliver under the
          // long-tail outliers. The band above it gets whatever rate
          // (`cycleTimeAboveRate`, computed above) fits it into the fixed
          // container height instead. See registerCycleTimeExpandedScale
          // and cycleTimeAboveRateFor above.
          breakpoint: CYCLE_TIME_Y_BREAKPOINT,
          belowRate: CYCLE_TIME_LOW_BAND_HEIGHT_PX / CYCLE_TIME_Y_BREAKPOINT,
          aboveRate: cycleTimeAboveRate,
          // A hard floor, not just beginAtZero — the trendline can
          // extrapolate below zero at the edges of a narrow window (a
          // negative "duration days" isn't meaningful), and beginAtZero
          // only guarantees zero is *included*, not that it's the minimum.
          min: 0,
          title: { display: true, text: "Duration (days)", color: muted, font: { size: 10 } },
          grid: { color: gridline, drawTicks: false },
          border: { display: false },
          ticks: {
            color: muted,
            font: { size: 10 },
            callback: (value) => `${value}d`,
          },
        },
      },
    },
  });
}
