// Aging Buckets panel — a waffle/pictogram grid of currently-open branches,
// exactly one square per branch (never a scaled/rounded fraction), grouped
// into 4 dynamic age buckets (Healthy / On track / Stale / Critical)
// against the dashboard's own P50/P85 cycle-time baseline. Plus a KPI
// header, a static per-bucket legend (range, count, % of open), a
// per-branch hover tooltip, and click-to-filter (clicking a square or a
// legend row reveals that bucket's branches below). Vanilla JS + plain
// HTML/CSS — no Chart.js here (a waffle isn't one of its built-in chart
// types, and this dashboard avoids extra dependencies), matching this
// dashboard's overall stack (see app.js). The bucketing math lives in
// aging-buckets-math.js, loaded before this file; this file is purely
// presentation (DOM rendering).
//
// Input: { branchId, name, ageInDays, createdDate, authorHandle }[] — the
// latter two are optional but drive the hover tooltip (see
// showWaffleTooltip) and its "Open in Figma" link — plus the dashboard's
// current { p50, p85 } cycle-time baseline (see app.js for where those
// come from).
// Usage: renderAgingBucketsWaffle({ gridEl, legendEl, kpiEl, detailsEl, branches, p50, p85 })

// A 4-step health ramp — light green (best) through dark red (worst) —
// rather than this dashboard's per-domain accent hues (--accent-figma
// etc.), since these colors mean "how healthy", not "which data domain".
// `stale` deliberately reuses cycle-time-scatter.js's CYCLE_TIME_P85_COLOR
// exactly (not just a similar red) — both mean the same thing, "past the
// P85 SLA line", so they should be the same color, and `critical` goes
// darker still from there for "well past it". Fixed hex rather than CSS
// variables: unlike the Chart.js charts elsewhere in this dashboard,
// nothing here needs to read a color back out of the page for a canvas —
// these are just inline `style` values, and they're deliberately
// theme-invariant (a critical branch is dark red in both themes). Shared
// with aging-history-chart.js (loaded after this file), so the waffle and
// the weekly history table always agree on what each bucket looks like.
const AGING_BUCKET_COLORS = {
  healthy: "#86efac", // green-300 (light green)
  onTrack: "#15803d", // green-700 (dark green)
  stale: "#ef4444", // red-500 — same as cycle-time-scatter.js's CYCLE_TIME_P85_COLOR
  critical: "#991b1b", // red-800 (dark red)
};

// Roughly-square grid dimensions for `total` waffle cells — not a fixed
// 10x10 (the classic "100 squares = 100%" waffle convention), since this
// waffle represents an exact, varying branch count rather than a fixed
// percentage. Clamped to [8, 20] columns so the grid neither goes
// absurdly wide (a dozen branches in one long row) nor absurdly narrow
// (a couple hundred branches stacked into only 8 columns).
function waffleColumnCount(total) {
  if (total <= 0) return 1;
  return Math.max(8, Math.min(20, Math.round(Math.sqrt(total))));
}

// Three tiles: total open branches counted (i.e. with a resolvable age),
// how many of those sit past the P85 SLA line (Stale + Critical), and the
// P85 threshold itself as a plain "SLA badge" number — all three update
// live with whatever P50/P85 baseline the caller passes in.
function renderAgingBucketsKpi(kpiEl, { totalOpen, staleCount, p85, excludedCount }) {
  if (!kpiEl) return;

  const stalePercent = totalOpen > 0 ? Math.round((staleCount / totalOpen) * 100) : 0;
  const staleClass = staleCount > 0 ? "kpi-delta-bad" : "";

  kpiEl.innerHTML = `
    <li class="metric-bullet">
      <span class="metric-bullet-label">Total open branches${excludedCount > 0 ? ` <span class="metric-bullet-note">(+${excludedCount} unknown age, excluded)</span>` : ""}</span>
      <span class="metric-bullet-value">${totalOpen}</span>
    </li>
    <li class="metric-bullet">
      <span class="metric-bullet-label">Stale branches (&gt; P85)</span>
      <span class="metric-bullet-value ${staleClass}">${staleCount} <span class="metric-bullet-sub">(${stalePercent}%)</span></span>
    </li>
    <li class="metric-bullet">
      <span class="metric-bullet-label">P85 SLA threshold</span>
      <span class="metric-bullet-value">${p85.toFixed(1)}d</span>
    </li>
  `;
}

// One row per bucket — swatch, label + numeric range, and count + % of
// open, always visible rather than hidden behind a hover tooltip (a waffle
// cell's own hover title only ever describes *one* branch, so the
// range/count/percentage story needs a home that isn't hover-only). Each
// row is also the click target for filtering — even a zero-count bucket
// gets a (disabled) row, so "view this bucket's branches" always means the
// same thing whether triggered from a cell or from here.
function renderAgingBucketsLegend(legendEl, buckets, detailsEl) {
  if (!legendEl) return;

  legendEl.innerHTML = buckets
    .map(
      (bucket) => `
      <button type="button" class="waffle-legend-row" data-bucket-id="${bucket.id}" ${bucket.count === 0 ? "disabled" : ""}>
        <span class="legend-dot" style="background:${AGING_BUCKET_COLORS[bucket.id]}" aria-hidden="true"></span>
        <span class="waffle-legend-label">${escapeHtml(bucket.label)} <span class="waffle-legend-range">${bucket.rangeLabel}</span></span>
        <span class="waffle-legend-count">${bucket.count} <span class="waffle-legend-percent">(${bucket.percent.toFixed(0)}%)</span></span>
      </button>`
    )
    .join("");

  legendEl.querySelectorAll(".waffle-legend-row").forEach((row) => {
    row.addEventListener("click", () => {
      const bucket = buckets.find((b) => b.id === row.dataset.bucketId);
      renderAgingBucketDetails(detailsEl, bucket ?? null);
    });
  });
}

// Same date formatter the Cycle time trend panel's own tooltip uses (see
// cycle-time-scatter.js, loaded before this file) — reused rather than
// redefined so the two hover cards read identically for the same
// underlying data.
const waffleTooltipDateFmt = cycleTimeTooltipDateFmt;

// A single tooltip element, shared across every cell rather than one per
// cell — a waffle can have hundreds of cells, and only one tooltip is ever
// shown at a time. Created lazily on first hover, appended to <body> so a
// `position: fixed` placement isn't clipped by this panel's own overflow.
let waffleTooltipEl = null;
let waffleTooltipHideTimer = null;

function ensureWaffleTooltipEl() {
  if (waffleTooltipEl) return waffleTooltipEl;
  const el = document.createElement("div");
  el.className = "waffle-tooltip";
  el.hidden = true;
  // The tooltip carries a real, clickable link (see showWaffleTooltip), so
  // it can't just disappear the instant the mouse leaves the cell — give
  // the pointer time to travel from the cell onto the tooltip itself.
  // Entering the tooltip cancels any pending hide; leaving it re-schedules
  // one, same as leaving a cell does.
  el.addEventListener("mouseenter", () => clearTimeout(waffleTooltipHideTimer));
  el.addEventListener("mouseleave", scheduleHideWaffleTooltip);
  document.body.appendChild(el);
  waffleTooltipEl = el;
  return el;
}

function scheduleHideWaffleTooltip() {
  clearTimeout(waffleTooltipHideTimer);
  waffleTooltipHideTimer = setTimeout(() => {
    if (waffleTooltipEl) waffleTooltipEl.hidden = true;
  }, 150);
}

// Positions the (already-visible, already-populated) tooltip above its
// cell, centered — flipping below when there isn't room above, and clamped
// horizontally so it never runs off either edge of the viewport. Read
// after the tooltip's content is set, since its size depends on that.
function positionWaffleTooltip(el, cell) {
  const cellRect = cell.getBoundingClientRect();
  const tipRect = el.getBoundingClientRect();
  const gap = 8;

  let top = cellRect.top - tipRect.height - gap;
  if (top < gap) top = cellRect.bottom + gap;

  let left = cellRect.left + cellRect.width / 2 - tipRect.width / 2;
  left = Math.max(gap, Math.min(left, window.innerWidth - tipRect.width - gap));

  el.style.top = `${top}px`;
  el.style.left = `${left}px`;
}

// Mirrors the Cycle time trend scatter plot's own per-branch tooltip
// (Author / Created / Duration, "exceeds P85 target" called out — see
// cycle-time-scatter.js) so the same branch reads identically whether
// you're looking at it as a dot there or a square here, plus a real link
// to open the branch in Figma (the scatter plot has no equivalent, since
// its dots are already-closed branches). `exceedsP85` comes from the
// bucket the branch is in — "stale" and "critical" are both, by
// definition, past the P85 line.
function showWaffleTooltip(cell, branch, bucket) {
  const el = ensureWaffleTooltipEl();
  clearTimeout(waffleTooltipHideTimer);

  const exceedsP85 = bucket.id === "stale" || bucket.id === "critical";
  const createdLabel = branch.createdDate ? waffleTooltipDateFmt.format(new Date(branch.createdDate)) : "Unknown";
  const url = `https://www.figma.com/file/${branch.branchId}`;

  el.innerHTML = `
    <p class="waffle-tooltip-title">${escapeHtml(branch.name)}</p>
    <p class="waffle-tooltip-row">Author: ${escapeHtml(branch.authorHandle ?? "Unknown")}</p>
    <p class="waffle-tooltip-row">Created: ${escapeHtml(createdLabel)}</p>
    <p class="waffle-tooltip-row">Duration: ${branch.ageInDays.toFixed(1)}d open${exceedsP85 ? " (exceeds P85 target)" : ""}</p>
    <a class="waffle-tooltip-link" href="${url}" target="_blank" rel="noopener">Open in Figma ↗</a>
  `;

  el.hidden = false;
  positionWaffleTooltip(el, cell);
}

// The waffle grid itself — one cell per branch (never a scaled/rounded
// fraction — see flattenAgingBucketsToUnits in aging-buckets-math.js,
// which emits exactly one unit per branch), ordered and colored by bucket.
// Cells are real <button>s, not styled <div>s, so the grid is keyboard-
// focusable/operable for free, and each carries a plain-text `aria-label`
// (screen readers don't get the richer hover tooltip, which needs a
// pointer). Hovering (or focusing) a cell shows that branch's own detail
// tooltip; *clicking* a cell instead filters to that cell's whole bucket
// (same action as clicking the matching legend row) — a waffle's point is
// the aggregate shape, so "show me just this one" is a hover action, not
// a click one.
function renderAgingBucketsGrid(gridEl, buckets, detailsEl) {
  if (!gridEl) return;

  const units = flattenAgingBucketsToUnits(buckets);
  gridEl.style.setProperty("--waffle-columns", waffleColumnCount(units.length));
  gridEl.innerHTML = "";

  const bucketsById = new Map(buckets.map((b) => [b.id, b]));

  for (const { bucketId, branch } of units) {
    const bucket = bucketsById.get(bucketId);
    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = "waffle-cell";
    cell.style.background = AGING_BUCKET_COLORS[bucketId];
    cell.setAttribute("aria-label", `${branch.name} — ${branch.ageInDays.toFixed(1)}d open (${bucket.label})`);

    cell.addEventListener("mouseenter", () => showWaffleTooltip(cell, branch, bucket));
    cell.addEventListener("focus", () => showWaffleTooltip(cell, branch, bucket));
    cell.addEventListener("mouseleave", scheduleHideWaffleTooltip);
    cell.addEventListener("blur", scheduleHideWaffleTooltip);
    cell.addEventListener("click", () => renderAgingBucketDetails(detailsEl, bucket.count > 0 ? bucket : null));

    gridEl.appendChild(cell);
  }
}

// The click-to-filter list: renders the clicked bucket's branches (name +
// current age, longest-open first, so the branches needing the most
// attention lead the list), or hides the panel entirely when no bucket is
// selected (or the selected bucket is empty). Re-invoked with `null` by its
// own close button.
function renderAgingBucketDetails(detailsEl, bucket) {
  if (!detailsEl) return;

  if (!bucket || bucket.branches.length === 0) {
    detailsEl.hidden = true;
    detailsEl.innerHTML = "";
    return;
  }

  detailsEl.hidden = false;

  const rows = [...bucket.branches]
    .sort((a, b) => b.ageInDays - a.ageInDays)
    .map(
      (b) => `
      <div class="aging-branch-row">
        <span class="aging-branch-name">${escapeHtml(b.name)}</span>
        <span class="aging-branch-age">${b.ageInDays.toFixed(1)}d open</span>
      </div>`
    )
    .join("");

  detailsEl.innerHTML = `
    <div class="aging-branch-details-head">
      <p><strong>${escapeHtml(bucket.label)}</strong> (${bucket.rangeLabel}) — ${bucket.count} branch${bucket.count === 1 ? "" : "es"}</p>
      <button type="button" class="aging-branch-details-close" aria-label="Close branch list">✕</button>
    </div>
    <div class="aging-branch-list">${rows}</div>
  `;

  detailsEl.querySelector(".aging-branch-details-close").addEventListener("click", () => {
    renderAgingBucketDetails(detailsEl, null);
  });
}

// `gridEl`/`legendEl`: containers for the waffle grid and its legend rows.
// `kpiEl`/`detailsEl`: the KPI header and the click-to-filter branch list.
// `branches`: currently-open branches as { branchId, name, ageInDays }[] —
// age resolution (which branches even have a known creation date) is the
// caller's job; this just groups and draws whatever it's given.
// `excludedCount`: how many currently-open branches the caller already left
// out of `branches` (unresolvable/invalid age) — passed straight through
// since this module only ever sees the post-exclusion list and so can't
// derive that count itself (computeAgingBuckets's own null/negative-age
// check can never fire on already-filtered data). `p50`/`p85`: the
// dashboard's current cycle-time baseline (see app.js). Unlike the
// Chart.js-based charts elsewhere in this dashboard, there's no chart
// instance to destroy or resize afterward, and no theme-dependent colors
// baked in at render time — re-rendering (new data, a resize, a theme
// toggle) is just calling this again, and a plain CSS theme toggle needs
// no call at all.
function renderAgingBucketsWaffle({ gridEl, legendEl, kpiEl, detailsEl, branches, excludedCount = 0, p50, p85 }) {
  const computed = computeAgingBuckets(branches, { p50, p85 });
  renderAgingBucketDetails(detailsEl, null);

  if (!computed) {
    if (kpiEl) kpiEl.innerHTML = `<p class="branch-empty">Not enough closed-branch history yet to compute a P50/P85 baseline.</p>`;
    if (gridEl) gridEl.innerHTML = "";
    if (legendEl) legendEl.innerHTML = "";
    return;
  }

  renderAgingBucketsKpi(kpiEl, {
    totalOpen: computed.totalOpen,
    staleCount: computed.staleCount,
    p85: computed.p85,
    excludedCount,
  });

  renderAgingBucketsLegend(legendEl, computed.buckets, detailsEl);
  renderAgingBucketsGrid(gridEl, computed.buckets, detailsEl);
}
