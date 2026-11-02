// Branch creators panel — a squarified treemap (layout math in
// branch-creators-math.js, loaded before this file) with one box per
// creator, sized by how many *closed* (merged/archived) branches they've
// created in the Pintxo Design System file — still-open branches are left
// out, since they're already covered by the Aging Buckets waffle and aren't
// a finished contribution yet. Box shade is a sequential ramp on the same accent-figma
// hue (more branches = more of the hue, less of --surface) so size and color
// both point at the same "who created the most" story rather than color
// doing separate identity work — this is a magnitude comparison, not a
// per-person legend. Vanilla JS + plain HTML/CSS, same reasoning as the
// Aging Buckets waffle: a treemap isn't a Chart.js built-in and this
// dashboard avoids extra dependencies for one-off chart shapes.
// Usage: renderBranchCreatorsTreemap({ containerEl, kpiEl, detailsEl, branches })

// Same date formatter the Cycle time trend and Aging Buckets tooltips use
// (see cycle-time-scatter.js, loaded before this file) — reused so every
// per-branch hover card on this page reads dates identically.
const treemapTooltipDateFmt = cycleTimeTooltipDateFmt;

// Below this size a box can't fit a legible label (handle + count) without
// overflowing or wrapping into unreadable mush — those boxes still render
// (and are still fully hoverable/clickable), just unlabeled, relying on the
// hover tooltip and the aria-label for their content.
const TREEMAP_MIN_LABEL_WIDTH = 46;
const TREEMAP_MIN_LABEL_HEIGHT = 30;

// Sequential color ramp: `t` in [0, 1] (a creator's count relative to the
// panel's max) maps to how much accent-figma is mixed into --surface — 18%
// at the floor so even the smallest real box still reads as "on brand"
// rather than invisible against the panel background, 92% at the top so the
// single biggest contributor's box is unambiguously the darkest/most
// saturated one. `in srgb` matches how this dashboard already builds ad hoc
// tints elsewhere (see style.css's chip/badge backgrounds) rather than
// introducing a different color space just for this one chart.
function treemapCellColor(t) {
  const percent = Math.round(18 + t * 74);
  return `color-mix(in srgb, var(--accent-figma) ${percent}%, var(--surface))`;
}

// Renders the KPI header — total branches counted, how many distinct
// creators that's spread across, and the single biggest contributor — using
// the same .metric-bullets markup as the Aging Buckets and Cycle time
// panels, so the three read as one family of "quick numbers above a chart".
function renderBranchCreatorsKpi(kpiEl, { totalBranches, totalCreators, topCreator }) {
  if (!kpiEl) return;

  kpiEl.innerHTML = `
    <li class="metric-bullet">
      <span class="metric-bullet-label">Closed branches counted</span>
      <span class="metric-bullet-value">${totalBranches}</span>
    </li>
    <li class="metric-bullet">
      <span class="metric-bullet-label">Distinct creators</span>
      <span class="metric-bullet-value">${totalCreators}</span>
    </li>
    <li class="metric-bullet">
      <span class="metric-bullet-label">Top creator</span>
      <span class="metric-bullet-value">${escapeHtml(topCreator.handle)} <span class="metric-bullet-sub">(${topCreator.count})</span></span>
    </li>
  `;
}

// The click-through list for one creator's box: every closed branch they've
// created, newest first, name linked to Figma — same row shape as
// renderBranchActivityDetails's (see app.js), just grouped by creator
// instead of by time bucket.
function renderBranchCreatorDetails(detailsEl, creator) {
  if (!detailsEl) return;

  if (!creator || creator.branches.length === 0) {
    detailsEl.hidden = true;
    detailsEl.innerHTML = "";
    return;
  }

  detailsEl.hidden = false;

  const rows = [...creator.branches]
    .sort((a, b) => new Date(b.createdAt ?? 0) - new Date(a.createdAt ?? 0))
    .map((branch) => {
      const createdLabel = branch.createdAt
        ? treemapTooltipDateFmt.format(new Date(branch.createdAt))
        : "Unknown";
      return `
      <div class="aging-branch-row">
        <a
          class="aging-branch-name aging-branch-name-link"
          href="https://www.figma.com/file/${branch.key}"
          target="_blank"
          rel="noopener"
        >${escapeHtml(branch.name)}</a>
        <span class="aging-branch-age">Created ${createdLabel}</span>
      </div>`;
    })
    .join("");

  detailsEl.innerHTML = `
    <div class="aging-branch-details-head">
      <p><strong>${escapeHtml(creator.handle)}</strong> — ${creator.branches.length} branch${creator.branches.length === 1 ? "" : "es"}</p>
      <button type="button" class="aging-branch-details-close" aria-label="Close branch list">✕</button>
    </div>
    <div class="aging-branch-list">${rows}</div>
  `;

  detailsEl.querySelector(".aging-branch-details-close").addEventListener("click", () => {
    renderBranchCreatorDetails(detailsEl, null);
  });
}

// Per-box hover tooltip — reuses the Aging Buckets waffle's tooltip element
// and positioning (ensureWaffleTooltipEl/positionWaffleTooltip/
// scheduleHideWaffleTooltip, all in aging-buckets-waffle.js, loaded before
// this file): those are generic "one shared tooltip, positioned above
// whatever cell triggered it" helpers with nothing waffle-specific in their
// logic, so a second content renderer here is cheaper than a parallel copy.
function showTreemapTooltip(cell, creator) {
  const el = ensureWaffleTooltipEl();
  clearTimeout(waffleTooltipHideTimer);

  el.innerHTML = `
    <p class="waffle-tooltip-title">${escapeHtml(creator.handle)}</p>
    <p class="waffle-tooltip-row">${creator.count} branch${creator.count === 1 ? "" : "es"} (${creator.percent.toFixed(1)}% of all closed)</p>
    <p class="waffle-tooltip-row">Click the box to list them</p>
  `;

  el.hidden = false;
  positionWaffleTooltip(el, cell);
}

// Module state so a resize can repaint the same data without recomputing
// the creator grouping, and so the ResizeObserver below is only ever
// attached once per container rather than once per render.
let treemapContainerEl = null;
let treemapCreators = null;
let treemapDetailsEl = null;
let treemapResizeObserver = null;

// Lays out and paints whatever's currently in treemapCreators into
// treemapContainerEl at its *current* measured size — separated from
// renderBranchCreatorsTreemap so a resize can call just this half.
function paintBranchCreatorsTreemap() {
  const containerEl = treemapContainerEl;
  const creators = treemapCreators;
  if (!containerEl || !creators) return;

  const width = containerEl.clientWidth;
  const height = containerEl.clientHeight;
  containerEl.innerHTML = "";

  if (width <= 0 || height <= 0) return; // Panel is hidden.

  if (creators.length === 0) {
    containerEl.innerHTML = `<p class="treemap-empty">No branches seen yet.</p>`;
    return;
  }

  const maxCount = Math.max(...creators.map((c) => c.count));
  const rects = computeTreemapLayout(
    creators.map((c) => c.count),
    width,
    height
  );

  creators.forEach((creator, i) => {
    const rect = rects[i];
    if (rect.width <= 0 || rect.height <= 0) return;

    // A 1px inset on every side reads as a visible gap between boxes
    // without complicating the (purely area-based) layout math above with
    // gap-aware geometry.
    const cellWidth = Math.max(0, rect.width - 2);
    const cellHeight = Math.max(0, rect.height - 2);

    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = "treemap-cell";
    cell.style.left = `${rect.x + 1}px`;
    cell.style.top = `${rect.y + 1}px`;
    cell.style.width = `${cellWidth}px`;
    cell.style.height = `${cellHeight}px`;
    cell.style.background = treemapCellColor(creator.count / maxCount);
    cell.setAttribute(
      "aria-label",
      `${creator.handle} — ${creator.count} branch${creator.count === 1 ? "" : "es"} (${creator.percent.toFixed(1)}%)`
    );

    if (cellWidth >= TREEMAP_MIN_LABEL_WIDTH && cellHeight >= TREEMAP_MIN_LABEL_HEIGHT) {
      cell.innerHTML = `
        <span class="treemap-cell-label-wrap">
          <span class="treemap-cell-label">${escapeHtml(creator.handle)}</span>
          <span class="treemap-cell-count">${creator.count}</span>
        </span>
      `;
    }

    cell.addEventListener("mouseenter", () => showTreemapTooltip(cell, creator));
    cell.addEventListener("focus", () => showTreemapTooltip(cell, creator));
    cell.addEventListener("mouseleave", scheduleHideWaffleTooltip);
    cell.addEventListener("blur", scheduleHideWaffleTooltip);
    cell.addEventListener("click", () => renderBranchCreatorDetails(treemapDetailsEl, creator));

    containerEl.appendChild(cell);
  });
}

// `containerEl`: the treemap's box (a .chart-box, so it has a fixed height —
// see style.css). `kpiEl`/`detailsEl`: the KPI header and click-through
// branch list. `branches`: every *closed* branch, as
// { key, name, authorHandle, createdAt }[] — grouping and the "Other"
// fold-in are computeBranchCreatorCounts's job (branch-creators-math.js);
// this just draws whatever it's given. Colors are computed at
// paint time from CSS variables via color-mix, so — unlike the Chart.js
// charts elsewhere on this page — a theme toggle re-themes every box for
// free with no re-render needed.
function renderBranchCreatorsTreemap({ containerEl, kpiEl, detailsEl, branches }) {
  if (!containerEl) return;

  const creators = computeBranchCreatorCounts(branches);
  renderBranchCreatorDetails(detailsEl, null);

  treemapContainerEl = containerEl;
  treemapCreators = creators;
  treemapDetailsEl = detailsEl;

  if (creators.length === 0) {
    if (kpiEl) kpiEl.innerHTML = `<p class="branch-empty">No branches seen yet.</p>`;
    containerEl.innerHTML = "";
    return;
  }

  renderBranchCreatorsKpi(kpiEl, {
    totalBranches: branches.length,
    // Not creators.length: computeBranchCreatorCounts folds everyone past
    // the top TREEMAP_MAX_CREATORS into one "Other" box, so that length is
    // the box count, not the true distinct-author count once folding kicks
    // in. Recompute the real count directly from the source branches, the
    // same "Unknown" fallback computeBranchCreatorCounts uses per-author.
    totalCreators: new Set(branches.map((b) => b.authorHandle || "Unknown")).size,
    // Not creators[0]: computeBranchCreatorCounts now inserts "Other" into
    // its correct sorted position rather than always appending it last, so
    // a large enough folded-in tail can legitimately sort ahead of every
    // individually-kept creator. "Other" is never a real person, so skip
    // past it here — the first non-Other entry is always the single
    // largest genuine creator, by construction of the kept/rest split.
    topCreator: creators.find((c) => !c.isOther) ?? creators[0],
  });

  paintBranchCreatorsTreemap();

  // Attached once per container: the viewport (and so the panel's width)
  // can change at any time the Branches tab is open, and unlike Chart.js
  // there's no built-in resize handling for a plain absolutely-positioned
  // div layout.
  if (!treemapResizeObserver) {
    treemapResizeObserver = new ResizeObserver(() => paintBranchCreatorsTreemap());
    treemapResizeObserver.observe(containerEl);
  }
}
