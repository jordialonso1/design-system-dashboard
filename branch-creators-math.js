// Pure math for the Branch creators treemap (presentation in
// branch-creators-treemap.js, loaded after this file) — grouping branches by
// creator and laying the groups out as a squarified treemap. No DOM/Chart.js
// here, same split as cycle-time-math.js/aging-buckets-math.js.

// Beyond this many distinct creators, the smallest ones fold into a single
// "Other" box rather than each getting a sliver too small to read or click
// accurately — the treemap's job is "who are the handful of biggest
// contributors", not an exhaustive per-person breakdown (that's what the
// Library branches list below it is for).
const TREEMAP_MAX_CREATORS = 24;

// `branches`: { key, name, authorHandle, createdAt, isOpen }[] — every branch
// this dashboard has ever seen (open or since merged/archived), one entry
// each. Missing authorHandle groups under "Unknown", same label the rest of
// the Branches tab uses for it. Returns creators sorted by count descending
// (the order the squarify layout below expects for good aspect ratios), each
// carrying its own branches (for the click-through detail list) and its
// share of the total as a percent.
function computeBranchCreatorCounts(branches, { maxCreators = TREEMAP_MAX_CREATORS } = {}) {
  const byHandle = new Map();

  for (const branch of branches) {
    const handle = branch.authorHandle || "Unknown";
    const entry = byHandle.get(handle) ?? { handle, count: 0, branches: [] };
    entry.count += 1;
    entry.branches.push(branch);
    byHandle.set(handle, entry);
  }

  const sorted = [...byHandle.values()].sort(
    (a, b) => b.count - a.count || a.handle.localeCompare(b.handle)
  );

  let creators = sorted;
  if (sorted.length > maxCreators) {
    const kept = sorted.slice(0, maxCreators - 1);
    const rest = sorted.slice(maxCreators - 1);
    const otherBranches = rest.flatMap((c) => c.branches);
    const other = {
      handle: `Other (${rest.length} creators)`,
      count: otherBranches.length,
      branches: otherBranches,
      isOther: true,
    };
    // Insert "Other" into its correct descending-by-count position rather
    // than always appending it last — the folded-in tail's combined count
    // can exceed several individually-kept creators (e.g. 20 people with 2
    // branches each folding into an "Other" of 40), and this function's
    // own contract ("sorted by count descending, the order the squarify
    // layout below expects for good aspect ratios") needs to actually hold
    // once folding kicks in, not just before it.
    const insertAt = kept.findIndex((c) => c.count < other.count);
    creators = insertAt === -1 ? [...kept, other] : [...kept.slice(0, insertAt), other, ...kept.slice(insertAt)];
  }

  const total = branches.length;
  return creators.map((c) => ({ ...c, percent: total > 0 ? (c.count / total) * 100 : 0 }));
}

// Classic "squarified" treemap layout (Bruls, Huizing, van Wijk) — lays out
// `values` (assumed already sorted descending, though the algorithm doesn't
// require it) to fill a `containerWidth` x `containerHeight` rectangle,
// keeping each box's aspect ratio as close to square as it can rather than
// the long slivers a naive proportional-slice layout produces. Returns one
// { x, y, width, height } per value, in the same order as `values` — pure
// geometry, no color/DOM here.
function computeTreemapLayout(values, containerWidth, containerHeight) {
  if (containerWidth <= 0 || containerHeight <= 0) {
    return values.map(() => ({ x: 0, y: 0, width: 0, height: 0 }));
  }

  const total = values.reduce((sum, v) => sum + v, 0);
  if (total <= 0) {
    return values.map(() => ({ x: 0, y: 0, width: 0, height: 0 }));
  }

  const totalArea = containerWidth * containerHeight;
  const rects = new Array(values.length);
  let remaining = values.map((value, index) => ({ area: (value / total) * totalArea, index }));
  let x = 0;
  let y = 0;
  let width = containerWidth;
  let height = containerHeight;

  function worstAspectRatio(row, sideLength) {
    const rowSum = row.reduce((sum, r) => sum + r.area, 0);
    const rowMax = Math.max(...row.map((r) => r.area));
    const rowMin = Math.min(...row.map((r) => r.area));
    return Math.max(
      (sideLength * sideLength * rowMax) / (rowSum * rowSum),
      (rowSum * rowSum) / (sideLength * sideLength * rowMin)
    );
  }

  while (remaining.length > 0) {
    const shortSide = Math.min(width, height);
    let row = [remaining[0]];
    let rowWorst = worstAspectRatio(row, shortSide);

    for (let i = 1; i < remaining.length; i++) {
      const candidateRow = [...row, remaining[i]];
      const candidateWorst = worstAspectRatio(candidateRow, shortSide);
      // Squarify's stopping rule: keep adding to the row only while doing so
      // improves (or holds) the worst aspect ratio in it; the moment adding
      // the next item would make some box in the row less square, that item
      // starts the next row instead.
      if (candidateWorst > rowWorst) break;
      row = candidateRow;
      rowWorst = candidateWorst;
    }

    const rowArea = row.reduce((sum, r) => sum + r.area, 0);
    const layoutWide = width >= height;
    const rowThickness = layoutWide ? rowArea / height : rowArea / width;

    let offset = 0;
    for (const item of row) {
      const itemLength = rowThickness > 0 ? item.area / rowThickness : 0;
      if (layoutWide) {
        rects[item.index] = { x, y: y + offset, width: rowThickness, height: itemLength };
      } else {
        rects[item.index] = { x: x + offset, y, width: itemLength, height: rowThickness };
      }
      offset += itemLength;
    }

    if (layoutWide) {
      x += rowThickness;
      width -= rowThickness;
    } else {
      y += rowThickness;
      height -= rowThickness;
    }

    remaining = remaining.slice(row.length);
  }

  return rects;
}
