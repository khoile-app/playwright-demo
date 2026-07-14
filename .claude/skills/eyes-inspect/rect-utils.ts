export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface DiffArea extends Rect {
  diffCount: number;
}


const COL_WIDTH = 200;         // target column width; numCols = round(boundsWidth / COL_WIDTH)
const ROW_HEIGHT = 700;        // target row height;  numRows = round(boundsHeight / ROW_HEIGHT)
const DENSE_COVERAGE = 0.30;   // min ratio of diff pixel coverage to cell area to mark a cell dense
const MAX_MERGE_GAP_ROWS = 1;
const MAX_MERGE_GAP_COLS = 1;

function cellKey(row: number, col: number): string {
  return `${row},${col}`;
}

function parseKey(key: string): [number, number] {
  const [row, col] = key.split(',').map(Number);
  return [row, col];
}

/**
 * Condenses a large number of DiffAreas into grouped ContainerDiffArea objects.
 * When the number of areas is <= threshold, returns the original array unchanged.
 *
 * Each area is assigned to every grid cell it overlaps. A cell is dense when the
 * total area of diff pixels covering it meets DENSE_COVERAGE (ratio to cell area).
 * Dense cells are flood-filled into connected components, each producing a single
 * ContainerDiffArea bounding box. Adjacent containers (gap ≤ 1 cell, or one contains
 * the other) are merged. Finally, any unclaimed area whose rect falls completely inside
 * a container is absorbed into it.
 */
export function condenseDiffAreas(areas: DiffArea[], threshold = 20): DiffArea[] {
  const { containers, individuals } = condenseDiffAreasDetailed(areas, threshold);
  return [...containers, ...individuals];
}

export function condenseDiffAreasDetailed(
  areas: DiffArea[],
  threshold = 20,
): { containers: DiffArea[]; individuals: DiffArea[] } {
  if (areas.length <= threshold) return { containers: [], individuals: areas };

  // Compute bounding rect of all diff areas and derive a uniform grid.
  // numCols/numRows are chosen so each cell is as close to COL_WIDTH × ROW_HEIGHT as possible;
  // edge cells are never narrow/short because the grid divides the bounds evenly.
  const boundsLeft   = Math.min(...areas.map(a => a.left));
  const boundsTop    = Math.min(...areas.map(a => a.top));
  const boundsRight  = Math.max(...areas.map(a => a.left + a.width));
  const boundsBottom = Math.max(...areas.map(a => a.top + a.height));
  const boundsWidth  = boundsRight  - boundsLeft;
  const boundsHeight = boundsBottom - boundsTop;
  const numCols = Math.max(1, Math.round(boundsWidth  / COL_WIDTH));
  const numRows = Math.max(1, Math.round(boundsHeight / ROW_HEIGHT));
  const colW = Math.max(1, boundsWidth  / numCols);
  const rowH = Math.max(1, boundsHeight / numRows);
  const cellArea = colW * rowH;

  // Assign each area to every cell it overlaps; accumulate intersection pixel area per cell
  const cellCoverage = new Map<string, number>();
  for (const a of areas) {
    const colMin = Math.max(0, Math.floor((a.left - boundsLeft) / colW));
    const colMax = Math.min(numCols - 1, Math.ceil((a.left + a.width - boundsLeft) / colW) - 1);
    const rowMin = Math.max(0, Math.floor((a.top - boundsTop) / rowH));
    const rowMax = Math.min(numRows - 1, Math.ceil((a.top + a.height - boundsTop) / rowH) - 1);
    for (let row = rowMin; row <= rowMax; row++) {
      for (let col = colMin; col <= colMax; col++) {
        const cellLeft = boundsLeft + col * colW;
        const cellTop  = boundsTop  + row * rowH;
        const iW = Math.min(a.left + a.width,  cellLeft + colW) - Math.max(a.left, cellLeft);
        const iH = Math.min(a.top  + a.height, cellTop  + rowH) - Math.max(a.top,  cellTop);
        const iArea = Math.max(0, iW) * Math.max(0, iH);
        if (iArea > 0) {
          const key = cellKey(row, col);
          cellCoverage.set(key, (cellCoverage.get(key) ?? 0) + iArea);
        }
      }
    }
  }

  // Mark cells whose coverage ratio meets the density threshold
  const denseCells = new Set<string>();
  for (const [key, coverage] of cellCoverage) {
    if (coverage / cellArea >= DENSE_COVERAGE) denseCells.add(key);
  }

  // 4-connected flood-fill over dense cells into components
  const visited = new Set<string>();
  const components: Set<string>[] = [];
  for (const startKey of denseCells) {
    if (visited.has(startKey)) continue;
    const component = new Set<string>();
    const queue = [startKey];
    while (queue.length > 0) {
      const key = queue.pop()!;
      if (visited.has(key)) continue;
      visited.add(key);
      component.add(key);
      const [row, col] = parseKey(key);
      for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const neighborKey = cellKey(row + dr, col + dc);
        if (denseCells.has(neighborKey) && !visited.has(neighborKey)) {
          queue.push(neighborKey);
        }
      }
    }
    components.push(component);
  }

  // For each component, claim every area that overlaps any cell in the component
  const claimed = new Set<number>();
  const containers: DiffArea[] = [];

  for (const component of components) {
    const collectedIndices: number[] = [];
    for (let i = 0; i < areas.length; i++) {
      const a = areas[i];
      const colMin = Math.max(0, Math.floor((a.left - boundsLeft) / colW));
      const colMax = Math.min(numCols - 1, Math.ceil((a.left + a.width - boundsLeft) / colW) - 1);
      const rowMin = Math.max(0, Math.floor((a.top - boundsTop) / rowH));
      const rowMax = Math.min(numRows - 1, Math.ceil((a.top + a.height - boundsTop) / rowH) - 1);
      let found = false;
      outer: for (let row = rowMin; row <= rowMax; row++) {
        for (let col = colMin; col <= colMax; col++) {
          if (component.has(cellKey(row, col))) { found = true; break outer; }
        }
      }
      if (found) collectedIndices.push(i);
    }
    if (collectedIndices.length === 0) continue;
    for (const idx of collectedIndices) claimed.add(idx);

    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    let totalDiffCount = 0;
    for (const idx of collectedIndices) {
      const a = areas[idx];
      left  = Math.min(left,  a.left);
      top   = Math.min(top,   a.top);
      right = Math.max(right, a.left + a.width);
      bottom = Math.max(bottom, a.top + a.height);
      totalDiffCount += a.diffCount;
    }
    containers.push({ left, top, width: right - left, height: bottom - top, diffCount: totalDiffCount });
  }

  // Merge containers that are gap-adjacent (≤ 1 cell in either axis) or where one contains the other
  let anyMerge = true;
  while (anyMerge) {
    anyMerge = false;
    outer: for (let i = 0; i < containers.length; i++) {
      for (let j = i + 1; j < containers.length; j++) {
        const a = containers[i];
        const b = containers[j];
        const hGap = Math.max(0, Math.max(a.left, b.left) - Math.min(a.left + a.width,  b.left + b.width));
        const vGap = Math.max(0, Math.max(a.top,  b.top)  - Math.min(a.top  + a.height, b.top  + b.height));
        const contained = rectContains(a, b) || rectContains(b, a);
        if (!contained && (hGap > MAX_MERGE_GAP_COLS * colW || vGap > MAX_MERGE_GAP_ROWS * rowH)) continue;
        const left   = Math.min(a.left, b.left);
        const top    = Math.min(a.top,  b.top);
        const right  = Math.max(a.left + a.width,  b.left + b.width);
        const bottom = Math.max(a.top  + a.height, b.top  + b.height);
        containers.splice(j, 1);
        containers.splice(i, 1);
        containers.push({ left, top, width: right - left, height: bottom - top, diffCount: a.diffCount + b.diffCount });
        anyMerge = true;
        break outer;
      }
    }
  }

  // Absorb any unclaimed area whose rect falls completely within a container
  for (let i = 0; i < areas.length; i++) {
    if (claimed.has(i)) continue;
    for (const container of containers) {
      if (rectContains(container, areas[i])) {
        container.diffCount += areas[i].diffCount;
        claimed.add(i);
        break;
      }
    }
  }

  return { containers, individuals: areas.filter((_, i) => !claimed.has(i)) };
}

export function parseRect(s: string): Rect {
  const parts = s.split(',').map(Number);
  if (parts.length !== 4 || parts.some(isNaN)) {
    throw new Error(`Invalid rect format: "${s}". Expected "left,top,width,height"`);
  }
  return { left: parts[0], top: parts[1], width: parts[2], height: parts[3] };
}

/**
 * Returns true if outer completely contains inner (all edges of inner are within outer).
 * Equal rectangles are considered to contain each other.
 */
export function rectContains(outer: Rect, inner: Rect): boolean {
  return (
    outer.left <= inner.left &&
    outer.top <= inner.top &&
    outer.left + outer.width >= inner.left + inner.width &&
    outer.top + outer.height >= inner.top + inner.height
  );
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return (
    a.left < b.left + b.width &&
    a.left + a.width > b.left &&
    a.top < b.top + b.height &&
    a.top + a.height > b.top
  );
}

export function intersectionArea(a: Rect, b: Rect): number {
  const w = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
  const h = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
  return w > 0 && h > 0 ? w * h : 0;
}

export function boundingRect(a: Rect, b: Rect): Rect {
  const left = Math.min(a.left, b.left);
  const top = Math.min(a.top, b.top);
  const right = Math.max(a.left + a.width, b.left + b.width);
  const bottom = Math.max(a.top + a.height, b.top + b.height);
  return { left, top, width: right - left, height: bottom - top };
}

/**
 * Expands a rect by `padding` pixels on every side.
 * When `imageWidth`/`imageHeight` are provided the result is clipped to the image bounds.
 */
export function padRect(rect: Rect, padding: number, imageWidth = Infinity, imageHeight = Infinity): Rect {
  const left = Math.max(0, rect.left - padding);
  const top = Math.max(0, rect.top - padding);
  const right = Math.min(imageWidth, rect.left + rect.width + padding);
  const bottom = Math.min(imageHeight, rect.top + rect.height + padding);
  return { left, top, width: right - left, height: bottom - top };
}

/** Merges pairs of rects that overlap by more than 10% of the smaller rect's area. */
export function unifyRects(rects: Rect[]): Rect[] {
  let result = [...rects];

  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < result.length; i++) {
      for (let j = i + 1; j < result.length; j++) {
        const overlap = intersectionArea(result[i], result[j]);
        const smallerArea = Math.min(result[i].width * result[i].height, result[j].width * result[j].height);
        if (overlap / smallerArea > 0.1) {
          result = [
            ...result.slice(0, i),
            ...result.slice(i + 1, j),
            ...result.slice(j + 1),
            boundingRect(result[i], result[j]),
          ];
          merged = true;
          break outer;
        }
      }
    }
  }
  return result;
}

/**
 * Returns coarse page areas containing diffs. Each rect is expanded to at least
 * `hPad`×`vPad` (centered) before checking for overlap; overlapping inflated rects
 * are merged into the bounding rect of their originals (not the inflated ones).
 */
export function diffAreas(rects: Rect[], hPad = 50, vPad = 25): DiffArea[] {
  let result: DiffArea[] = rects.map(r => ({ ...r, diffCount: 1 }));

  let merged = true;
  while (merged) {
    merged = false;
    const inflated = result.map((r: Rect) => {
      const w = Math.max(r.width, hPad);
      const h = Math.max(r.height, vPad);
      return { left: r.left + (r.width - w) / 2, top: r.top + (r.height - h) / 2, width: w, height: h };
    });
    outer: for (let i = 0; i < result.length; i++) {
      for (let j = i + 1; j < result.length; j++) {
        if (rectsIntersect(inflated[i], inflated[j])) {
          const mergedRect: DiffArea = {
            ...boundingRect(result[i], result[j]),
            diffCount: result[i].diffCount + result[j].diffCount,
          };
          result = [
            ...result.slice(0, i),
            ...result.slice(i + 1, j),
            ...result.slice(j + 1),
            mergedRect,
          ];
          merged = true;
          break outer;
        }
      }
    }
  }
  return result;
}
