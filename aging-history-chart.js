// Aging History chart — one stacked bar per recorded Monday, showing how
// the open-branch age distribution (see aging-buckets-waffle.js) has moved
// week to week. Vanilla JS + Chart.js — this dashboard's existing bar-chart
// stack (see groupedBarChart in app.js for the closest precedent: same
// index-mode tooltip, same "no legend, rely on established colors"
// convention), reusing the exact same bucket colors as the waffle chart
// (AGING_BUCKET_COLORS, from aging-buckets-waffle.js) so the two panels
// never disagree on what a color means. The derived-metrics math lives in
// aging-history-math.js, loaded before this file; this file is purely
// presentation (Chart.js config + the click-to-inspect panel's DOM
// rendering).
//
// Input: weeklySnapshots in the shape aging-history-math.js's
// computeWeeklySnapshotStats expects — sourcing them from real history is
// app.js's job (computeWeeklyAgingSnapshots).
// Usage: createAgingHistoryChart({ canvas, detailsEl, weeklySnapshots })

// Stacking order bottom-to-top: healthiest first, most severe last — same
// top-to-bottom order the waffle's legend and grid fill already use, so a
// reader scanning between the two never has to remap "which end is good".
const AGING_HISTORY_BUCKET_DATASETS = [
  { id: "p50Under", label: "Healthy (< P50)", color: AGING_BUCKET_COLORS.healthy },
  { id: "p50ToP85", label: "On track (P50–P85)", color: AGING_BUCKET_COLORS.onTrack },
  { id: "p85To2xP85", label: "Stale (P85–2×P85)", color: AGING_BUCKET_COLORS.stale },
  { id: "p85Over2x", label: "Critical (>2×P85)", color: AGING_BUCKET_COLORS.critical },
];

// The click-to-inspect panel: a single week's full breakdown, or hidden
// when nothing is selected. Re-invoked with `null` by its own close
// button — same pattern as the waffle chart's branch-list panel.
function renderAgingHistoryDetails(detailsEl, week) {
  if (!detailsEl) return;

  if (!week) {
    detailsEl.hidden = true;
    detailsEl.innerHTML = "";
    return;
  }

  detailsEl.hidden = false;

  const wow = week.wowChange;
  const wowText = wow
    ? `Total open ${wow.totalOpen >= 0 ? "+" : ""}${wow.totalOpen}, stale ${wow.staleCount >= 0 ? "+" : ""}${wow.staleCount} vs. the previous recorded Monday.`
    : "Earliest recorded week — no prior Monday to compare against.";

  const excludedNote = week.excludedCount > 0 ? ` <span class="metric-bullet-note">(+${week.excludedCount} unknown age, excluded)</span>` : "";

  detailsEl.innerHTML = `
    <div class="aging-branch-details-head">
      <p><strong>${escapeHtml(formatWeekColumnLabel(week.weekNumber, week.mondayDate))}</strong> — ${week.totalOpen} open branches, ${week.staleRatio.toFixed(0)}% stale${excludedNote}</p>
      <button type="button" class="aging-branch-details-close" aria-label="Close week details">✕</button>
    </div>
    <dl class="branch-meta-grid">
      <div class="branch-meta-item"><dt>&lt; P50 (Healthy)</dt><dd>${week.buckets.p50Under}</dd></div>
      <div class="branch-meta-item"><dt>P50–P85 (On track)</dt><dd>${week.buckets.p50ToP85}</dd></div>
      <div class="branch-meta-item"><dt>P85–2×P85 (Stale)</dt><dd>${week.buckets.p85To2xP85}</dd></div>
      <div class="branch-meta-item"><dt>&gt; 2×P85 (Critical)</dt><dd>${week.buckets.p85Over2x}</dd></div>
    </dl>
    <p class="aging-history-detail-wow">${escapeHtml(wowText)}</p>
  `;

  detailsEl.querySelector(".aging-branch-details-close").addEventListener("click", () => {
    renderAgingHistoryDetails(detailsEl, null);
  });
}

// "▲ +12%" / "▼ -5%" / "No change" / "—" (no prior week, or the prior
// week had zero stale branches to measure a % change against) — kept
// uncolored, unlike this dashboard's other WoW badges (kpi-delta-good/
// -bad): Chart.js ticks can't style individual lines within one multi-line
// label differently from the rest, so a colored line here would force
// every line of every tick the same color instead. Note this isn't itself
// judged good/bad by the arrow direction — a falling stale count (▼) is
// the improvement, the reverse of how ▲/▼ read on the Total Open line
// this used to show.
function formatAgingHistoryPercentLine(percent) {
  if (percent == null) return "—";
  const rounded = Math.round(percent);
  if (rounded === 0) return "No change";
  return `${rounded > 0 ? "▲" : "▼"} ${rounded > 0 ? "+" : ""}${rounded}%`;
}

// A 5-line x-axis tick for one week: the week/date (matching every other
// week-labeled axis in this dashboard), that week's total open count and
// stale ratio (since this chart replaces what used to be two separate
// table rows, both stay visible at a glance without a hover), and the
// week-over-week % change in the *count* of stale branches — progress on
// working through the backlog, specifically, rather than the total open
// count (which isn't itself a good/bad signal the way a shrinking stale
// count is).
function agingHistoryTickLabel(stat) {
  return [
    `W${stat.weekNumber}`,
    agingHistoryWeekLabelFmt.format(new Date(stat.mondayDate)),
    `${stat.totalOpen} open`,
    `${stat.staleRatio.toFixed(0)}% stale`,
    formatAgingHistoryPercentLine(stat.wowChange?.staleCountPercent ?? null),
  ];
}

// `canvas`: a <canvas> element (wrap it in a sized container per the
// Chart.js/responsive gotcha noted in CLAUDE.md). `detailsEl`: the
// click-to-inspect panel. `weeklySnapshots`: raw input in
// aging-history-math.js's schema — this function derives every displayed
// number from it itself (via computeWeeklySnapshotStats), so the caller's
// only job is sourcing the weekly records, not computing anything about
// them. Returns the Chart.js instance, or null if there's nothing to plot
// (destroy the previous instance yourself before re-creating or clearing,
// same as the other charts in app.js — a null return means there's
// nothing to destroy next time).
function createAgingHistoryChart({ canvas, detailsEl, weeklySnapshots }) {
  const stats = computeWeeklySnapshotStats(weeklySnapshots);
  renderAgingHistoryDetails(detailsEl, null);

  if (!canvas) return null;

  // Toggle a sibling empty-state paragraph rather than replacing
  // canvas.parentElement.innerHTML: that used to delete the <canvas> node
  // itself (its parent's only child), so every later render's
  // document.getElementById("chart-aging-history") permanently returned
  // null and the panel could never draw a chart again for the rest of the
  // session, even after paging back to a window that does have data.
  const emptyEl = canvas.parentElement.querySelector(".aging-history-empty");
  if (stats.length === 0) {
    canvas.hidden = true;
    if (emptyEl) {
      emptyEl.hidden = false;
    } else {
      canvas.insertAdjacentHTML("afterend", `<p class="branch-empty aging-history-empty">No weekly snapshots recorded yet.</p>`);
    }
    return null;
  }
  canvas.hidden = false;
  if (emptyEl) emptyEl.hidden = true;

  const muted = getComputedStyle(document.documentElement).getPropertyValue("--ink-muted").trim();
  const gridline = getComputedStyle(document.documentElement).getPropertyValue("--gridline").trim();
  const surface = getComputedStyle(document.documentElement).getPropertyValue("--surface").trim();
  const border = getComputedStyle(document.documentElement).getPropertyValue("--border").trim();
  const ink = getComputedStyle(document.documentElement).getPropertyValue("--ink").trim();

  const datasets = AGING_HISTORY_BUCKET_DATASETS.map((bucket) => ({
    label: bucket.label,
    data: stats.map((s) => s.buckets[bucket.id]),
    backgroundColor: bucket.color,
    borderRadius: 3,
    maxBarThickness: 56,
  }));

  return new Chart(canvas, {
    type: "bar",
    data: { labels: stats.map(agingHistoryTickLabel), datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      onHover: (evt, elements) => {
        if (evt.native?.target) evt.native.target.style.cursor = elements.length ? "pointer" : "default";
      },
      onClick: (evt, elements) => {
        if (!elements.length) return;
        renderAgingHistoryDetails(detailsEl, stats[elements[0].index] ?? null);
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: surface,
          borderColor: border,
          borderWidth: 1,
          titleColor: ink,
          bodyColor: muted,
          padding: 10,
          boxPadding: 4,
          cornerRadius: 8,
          callbacks: {
            // The default title would join the 4-line tick array — a
            // clean single-line "W38 (Sep 14)" instead, matching every
            // other week-labeled tooltip in this dashboard.
            title: (items) => formatWeekColumnLabel(stats[items[0].dataIndex].weekNumber, stats[items[0].dataIndex].mondayDate),
          },
        },
      },
      scales: {
        x: {
          stacked: true,
          grid: { display: false },
          ticks: { color: muted, font: { size: 10 } },
        },
        y: {
          stacked: true,
          beginAtZero: true,
          title: { display: true, text: "Open branches", color: muted, font: { size: 10 } },
          grid: { color: gridline, drawTicks: false },
          border: { display: false },
          ticks: { color: muted, font: { size: 10 }, precision: 0 },
        },
      },
    },
  });
}
