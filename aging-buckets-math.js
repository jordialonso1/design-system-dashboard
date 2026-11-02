// Pure data-transformation functions behind the Aging Buckets panel (see
// aging-buckets-waffle.js, the only consumer). No DOM/Chart.js dependencies
// here — safe to unit test or reuse elsewhere. A "branch" throughout this
// file means, at minimum, { branchId, name, ageInDays: number } — extra
// fields pass through untouched into each bucket's `branches` array, so the
// click-to-filter UI can show whatever it needs without this file knowing
// about it.

// `historyKey` is the same 4 categories' field name in the Aging History
// table's stored-weekly-record schema (see aging-history-math.js's header
// comment) — a different naming convention for a stored record vs. a live
// branch list, not a different taxonomy. Kept on this canonical list (the
// one place these 4 buckets, their order, and their definitions live) so
// app.js's AGING_HISTORY_BUCKET_KEY_BY_ID can derive from it instead of
// maintaining its own separate copy of the same id-to-id mapping.
const AGING_BUCKET_DEFS = [
  { id: "healthy", historyKey: "p50Under", label: "Healthy", description: "Within normal turnaround — below the P50 median (cleanup branches excluded)." },
  { id: "onTrack", historyKey: "p50ToP85", label: "On track", description: "Above the median, but still within the P85 SLA boundary." },
  { id: "stale", historyKey: "p85To2xP85", label: "Stale", description: "Exceeds the P85 SLA target." },
  { id: "critical", historyKey: "p85Over2x", label: "Critical", description: "More than 2× the P85 target — severely delayed, needs immediate intervention." },
];

// Which of the 4 buckets a single age falls into, given the dashboard's
// current P50/P85 cycle-time baseline. Upper edges are inclusive (an age
// exactly equal to p85 counts as "onTrack", and so on; "healthy" is strictly
// below p50, so an age equal to p50 is "onTrack") so
// every age maps to exactly one bucket with no gap between them.
function agingBucketId(ageInDays, p50, p85) {
  if (ageInDays < p50) return "healthy";
  if (ageInDays <= p85) return "onTrack";
  if (ageInDays <= p85 * 2) return "stale";
  return "critical";
}

// The 4 buckets' numeric [min, max) ranges for the current P50/P85
// baseline — `max: Infinity` on the last one. Kept as its own function
// (rather than inlined into computeAgingBuckets) so the chart's x-axis
// labels and the branch grouping below are always derived from the exact
// same boundaries and can't drift apart.
function agingBucketRanges(p50, p85) {
  return [
    { id: "healthy", min: 0, max: p50 },
    { id: "onTrack", min: p50, max: p85 },
    { id: "stale", min: p85, max: p85 * 2 },
    { id: "critical", min: p85 * 2, max: Infinity },
  ];
}

// "≤ 1.0d" / "1.0d–19.9d" / "> 39.8d" — one decimal place, matching how
// short this dashboard's other axis labels are kept (see the date
// formatters in cycle-time-scatter.js).
function formatAgingRangeLabel({ min, max }) {
  const fmt = (d) => `${d.toFixed(1)}d`;
  if (min <= 0) return `< ${fmt(max)}`;
  if (max === Infinity) return `> ${fmt(min)}`;
  return `${fmt(min)}–${fmt(max)}`;
}

// Groups `branches` ({ branchId, name, ageInDays, ...rest }) into the 4
// dynamic aging buckets for the given P50/P85 baseline — the main entry
// point for this file. Returns null when there's no usable baseline yet
// (not enough closed-branch history to compute a P50/P85), so the caller
// can show an empty state instead of dividing by a null/zero threshold.
// Branches with a missing or negative `ageInDays` are dropped rather than
// forced into a bucket — `totalOpen` reflects only branches actually
// counted, so percentages stay internally consistent.
function computeAgingBuckets(branches, { p50, p85 }) {
  // Not `p85 <= 0`: percentile() already returns null (not 0) when there's
  // no data to compute from, so p50/p85 == null is the real "not enough
  // history yet" signal — a genuine p85 of exactly 0 (every closed branch
  // so far merged same-instant it was created) is a valid computed value,
  // not an absent one, and was being wrongly treated as "no baseline".
  if (p50 == null || p85 == null) return null;

  const ranges = agingBucketRanges(p50, p85);
  const byId = new Map(ranges.map((r) => [r.id, { ...r, branches: [] }]));

  let totalOpen = 0;
  for (const branch of branches) {
    if (branch.ageInDays == null || branch.ageInDays < 0) continue;
    totalOpen++;
    byId.get(agingBucketId(branch.ageInDays, p50, p85)).branches.push(branch);
  }

  const buckets = AGING_BUCKET_DEFS.map((def) => {
    const range = byId.get(def.id);
    const count = range.branches.length;
    return {
      ...def,
      min: range.min,
      max: range.max,
      rangeLabel: formatAgingRangeLabel(range),
      branches: range.branches,
      count,
      percent: totalOpen > 0 ? (count / totalOpen) * 100 : 0,
    };
  });

  const staleCount = buckets
    .filter((b) => b.id === "stale" || b.id === "critical")
    .reduce((sum, b) => sum + b.count, 0);

  return { p50, p85, totalOpen, staleCount, buckets };
}

// Flattens computeAgingBuckets' 4 buckets (in their fixed health order)
// into one ordered array of { bucketId, branch } units — the shape a
// waffle/pictogram chart wants: one visual unit per branch, grouped
// contiguously by bucket so a glance at the grid shows roughly what share
// of open branches falls in each health tier. Order is deliberately
// Healthy → On track → Stale → Critical (matches AGING_BUCKET_DEFS), not
// sorted by anything per-branch, so re-renders with the same data don't
// visually reshuffle within a bucket.
function flattenAgingBucketsToUnits(buckets) {
  // Within a bucket, ordered by creation date, newest first (equivalently
  // youngest age first) — buckets are age ranges, so this also keeps the
  // whole grid in one continuous creation-date order across buckets.
  const createdTime = (b) => (b.createdDate ? new Date(b.createdDate).getTime() : Date.now() - b.ageInDays * 86400000);
  return buckets.flatMap((bucket) =>
    [...bucket.branches]
      .sort((a, b) => createdTime(b) - createdTime(a))
      .map((branch) => ({ bucketId: bucket.id, branch }))
  );
}
