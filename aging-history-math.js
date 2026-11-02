// Pure data-transformation functions behind the Aging History table (see
// aging-history-chart.js, the only consumer). No DOM dependencies here —
// safe to unit test or reuse elsewhere.
//
// Input shape, one entry per recorded Monday:
//   { weekNumber: number, mondayDate: ISOString,
//     buckets: { p50Under, p50ToP85, p85To2xP85, p85Over2x } }
// The 4 bucket keys are the same 4 categories as the Aging Buckets waffle
// chart (aging-buckets-math.js's "healthy"/"onTrack"/"stale"/"critical"),
// just under schema-friendly names since this table's input is a stored
// weekly record, not a live branch list.

// Rolls one week's 4 bucket counts up into the two headline counts every
// other derived metric here is built from.
function agingHistoryBucketTotals(buckets) {
  const { p50Under, p50ToP85, p85To2xP85, p85Over2x } = buckets;
  const totalOpen = p50Under + p50ToP85 + p85To2xP85 + p85Over2x;
  const staleCount = p85To2xP85 + p85Over2x;
  return { totalOpen, staleCount };
}

// Attaches totalOpen, staleCount, staleRatio (% of totalOpen past P85),
// and wowChange (this week vs. the *immediately preceding* entry, once
// sorted — not necessarily 7 days earlier, if a Monday snapshot is
// missing) to every week. Sorts by mondayDate ascending first rather than
// trusting the caller's order — an out-of-order append has bitten this
// dashboard's own history.jsonl before (see CLAUDE.md's note on
// loadHistory()), and there's no reason to assume a caller here always
// hands weeks in order either. The oldest week's wowChange is null —
// there's nothing before it to compare against.
function computeWeeklySnapshotStats(weeklySnapshots) {
  const sorted = [...weeklySnapshots].sort((a, b) => new Date(a.mondayDate) - new Date(b.mondayDate));

  return sorted.map((snapshot, i) => {
    const { totalOpen, staleCount } = agingHistoryBucketTotals(snapshot.buckets);
    const staleRatio = totalOpen > 0 ? (staleCount / totalOpen) * 100 : 0;

    const previous = sorted[i - 1];
    let wowChange = null;
    if (previous) {
      const prevTotals = agingHistoryBucketTotals(previous.buckets);
      const prevStaleRatio = prevTotals.totalOpen > 0 ? (prevTotals.staleCount / prevTotals.totalOpen) * 100 : 0;
      wowChange = {
        totalOpen: totalOpen - prevTotals.totalOpen,
        staleCount: staleCount - prevTotals.staleCount,
        // Relative week-over-week % change in the *count* of stale
        // branches (progress on working through the backlog, not just how
        // the backlog's share of a shifting total moved) — null (not
        // Infinity/NaN) when the previous week had zero stale branches,
        // since "% change from zero" has no sensible value.
        staleCountPercent: prevTotals.staleCount > 0 ? ((staleCount - prevTotals.staleCount) / prevTotals.staleCount) * 100 : null,
        // Percentage-*point* change, not a percentage-of-a-percentage —
        // the table's own Stale Ratio row needs this directly rather than
        // re-deriving it from two already-computed ratios every render.
        staleRatio: staleRatio - prevStaleRatio,
      };
    }

    return { ...snapshot, totalOpen, staleCount, staleRatio, wowChange };
  });
}

// "W34 (Aug 17)" — the table's column header label.
const agingHistoryWeekLabelFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
function formatWeekColumnLabel(weekNumber, mondayDate) {
  return `W${weekNumber} (${agingHistoryWeekLabelFmt.format(new Date(mondayDate))})`;
}
