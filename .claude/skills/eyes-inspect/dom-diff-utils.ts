// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FlatNode {
  node: any;
  depth: number;
}

export interface Match {
  b: FlatNode | null;
  c: FlatNode | null;
}

export interface DiffNode {
  status: 'changed' | 'new' | 'missing';
  depth: number;
  baselineNode: any | null;   // null for 'new'
  checkpointNode: any | null; // null for 'missing'
  /** Set by pruneReplacements: the counterpart node to diff against for property reduction. */
  pairNode?: any;
}

export interface DisplacedEntry {
  status: 'displaced';
  count: number;
  depth: number;
  rect: { left: number; top: number; width: number; height: number };
  baseline: { rect: { left: number; top: number; width: number; height: number } };
}

export interface CollapsedMissingEntry {
  status: 'missing';
  tagName: string;
  depth: number;
  count: number;
  attributes?: Record<string, string>;
  rect: { left: number; top: number; width: number; height: number };
}

// ---------------------------------------------------------------------------
// Reading-order sort
// ---------------------------------------------------------------------------

function readingOrderCompare(a: any, b: any): number {
  const aR = a.rect, bR = b.rect;
  if (!aR && !bR) return 0;
  if (!aR) return 1;
  if (!bR) return -1;

  const aBottom = aR.top + aR.height;
  const bBottom = bR.top + bR.height;
  const overlapTop = Math.max(aR.top, bR.top);
  const overlapBottom = Math.min(aBottom, bBottom);
  const overlap = overlapBottom - overlapTop;
  const minHeight = Math.min(aR.height, bR.height);

  // "Same line" when vertical overlap > 50% of the shorter element's height
  if (minHeight > 0 && overlap / minHeight > 0.5) {
    return aR.left - bR.left;
  }
  return aR.top - bR.top;
}

// ---------------------------------------------------------------------------
// flattenTree
// ---------------------------------------------------------------------------

export function flattenTree(root: any): FlatNode[] {
  const result: FlatNode[] = [];

  function traverse(node: any, depth: number): void {
    if (!node) return;
    if (Array.isArray(node)) {
      for (const n of node) traverse(n, depth);
      return;
    }
    // Skip text/comment nodes and elements without a rect
    if (!node.tagName || node.tagName.startsWith('#')) return;
    if (!node.rect) return;

    result.push({ node, depth });

    const elementChildren = (node.childNodes ?? [])
      .filter((c: any) => c?.tagName && !c.tagName.startsWith('#') && c.rect);

    const sorted = [...elementChildren].sort(readingOrderCompare);
    for (const child of sorted) {
      traverse(child, depth + 1);
    }
  }

  traverse(root, 0);
  return result;
}

// ---------------------------------------------------------------------------
// nodeSimilarity
// ---------------------------------------------------------------------------

export function nodeSimilarity(a: any, b: any): number {
  const sameTag = a.tagName === b.tagName;
  let score = sameTag ? 0.25 : 0; // base score — only for same tag

  // Attribute Jaccard (weight 0.3, same-tag only — different tags have incompatible attr semantics)
  if (sameTag) {
    const aAttrs = a.attributes ?? {};
    const bAttrs = b.attributes ?? {};
    const allAttrKeys = new Set([...Object.keys(aAttrs), ...Object.keys(bAttrs)]);
    if (allAttrKeys.size > 0) {
      let matchCount = 0;
      for (const k of allAttrKeys) {
        if (aAttrs[k] === bAttrs[k]) matchCount++;
      }
      score += 0.3 * (matchCount / allAttrKeys.size);
    } else {
      score += 0.3; // no attributes: treat as full match for this component
    }
  }

  // Size similarity (weight 0.4): sub-pixel differences (<1px in each dimension) are treated as equal
  const aR = a.rect, bR = b.rect;
  if (aR && bR) {
    let sizeSim: number;
    if (Math.abs(aR.width - bR.width) < 1 && Math.abs(aR.height - bR.height) < 1) {
      sizeSim = 1;
    } else {
      const aArea = aR.width * aR.height;
      const bArea = bR.width * bR.height;
      const maxArea = Math.max(aArea, bArea);
      sizeSim = maxArea > 0 ? 1 - Math.abs(aArea - bArea) / maxArea : 1;
    }
    score += 0.4 * sizeSim;
  }

  // Position proximity (weight 0.05): sub-pixel distance (<1px) treated as same position
  if (aR && bR) {
    const aCx = aR.left + aR.width / 2;
    const aCy = aR.top + aR.height / 2;
    const bCx = bR.left + bR.width / 2;
    const bCy = bR.top + bR.height / 2;
    const dist = Math.sqrt((aCx - bCx) ** 2 + (aCy - bCy) ** 2);
    score += 0.05 * (dist < 1 ? 1 : Math.max(0, 1 - dist / 200));
  }

  // Text similarity (weight 0.3 — strong signal; applies across tag boundaries too)
  const aText = nodeText(a);
  const bText = nodeText(b);
  if (aText && bText) {
    if (aText === bText) {
      score += 0.3;
    } else {
      // Word-level Dice coefficient for partial matches
      const aWords = new Set(aText.toLowerCase().split(/\s+/).filter(Boolean));
      const bWords = new Set(bText.toLowerCase().split(/\s+/).filter(Boolean));
      const common = [...aWords].filter(w => bWords.has(w)).length;
      const dice = (2 * common) / (aWords.size + bWords.size);
      score += 0.3 * dice;
    }
  }

  const capped = Math.min(1, score);
  if (capped >= 1) {
    // Only truly identical nodes score 1.0; near-identical nodes cap at 0.95
    return !diffNodeProps(a, b).hasChanges ? 1 : 0.95;
  }
  return capped;
}

// ---------------------------------------------------------------------------
// LCS matching — weighted sequence alignment
// ---------------------------------------------------------------------------

export function lcsMatch(baseline: FlatNode[], checkpoint: FlatNode[]): Match[] {
  const n = baseline.length, m = checkpoint.length;

  // dp[i][j] = maximum total similarity score for aligning baseline[0..i-1] with checkpoint[0..j-1]
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  // 'align' | 'skipB' | 'skipC'
  const dir: string[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(''));

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const sim = nodeSimilarity(baseline[i - 1].node, checkpoint[j - 1].node);
      const alignScore = dp[i - 1][j - 1] + sim;
      const skipB = dp[i - 1][j];   // baseline[i-1] unmatched (missing)
      const skipC = dp[i][j - 1];   // checkpoint[j-1] unmatched (new)

      if (alignScore >= skipB && alignScore >= skipC) {
        dp[i][j] = alignScore;
        dir[i][j] = 'align';
      } else if (skipB >= skipC) {
        dp[i][j] = skipB;
        dir[i][j] = 'skipB';
      } else {
        dp[i][j] = skipC;
        dir[i][j] = 'skipC';
      }
    }
  }

  // Backtrack using stored directions
  const result: Match[] = [];
  let i = n, j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && dir[i][j] === 'align') {
      result.unshift({ b: baseline[i - 1], c: checkpoint[j - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dir[i][j] === 'skipC')) {
      result.unshift({ b: null, c: checkpoint[j - 1] });
      j--;
    } else {
      result.unshift({ b: baseline[i - 1], c: null });
      i--;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Property helpers
// ---------------------------------------------------------------------------

function nodeText(node: any): string {
  return (node.childNodes ?? [])
    .filter((c: any) => c?.tagName === '#text')
    .map((c: any) => c.text ?? '')
    .join('');
}

interface PropDiff {
  hasChanges: boolean;
  changedProps: Record<string, any>;
  baselineProps: Record<string, any>;
}

function diffNodeProps(b: any, c: any): PropDiff {
  const changedProps: Record<string, any> = {};
  const baselineProps: Record<string, any> = {};
  // tagName and rect are always rendered separately in output, so they go into
  // extraChanges rather than changedProps — but they do contribute to hasChanges.
  let extraChanges = 0;

  if (b.tagName !== c.tagName) extraChanges++;

  const bR = b.rect, cR = c.rect;
  const rectChanged = (bR && cR)
    ? Math.abs(bR.left - cR.left) >= 1 || Math.abs(bR.top - cR.top) >= 1 ||
      Math.abs(bR.width - cR.width) >= 1 || Math.abs(bR.height - cR.height) >= 1
    : !!(bR || cR);
  if (rectChanged) extraChanges++;

  // style
  const bStyle = b.style ?? {}, cStyle = c.style ?? {};
  const styleKeys = new Set([...Object.keys(bStyle), ...Object.keys(cStyle)]);
  const cStyleDiff: Record<string, any> = {}, bStyleDiff: Record<string, any> = {};
  for (const k of styleKeys) {
    if (bStyle[k] !== cStyle[k]) {
      cStyleDiff[k] = cStyle[k];
      bStyleDiff[k] = bStyle[k];
    }
  }
  if (Object.keys(cStyleDiff).length > 0) {
    changedProps.style = cStyleDiff;
    baselineProps.style = bStyleDiff;
  }

  // attributes
  const bAttrs = b.attributes ?? {}, cAttrs = c.attributes ?? {};
  const attrKeys = new Set([...Object.keys(bAttrs), ...Object.keys(cAttrs)]);
  const cAttrDiff: Record<string, any> = {}, bAttrDiff: Record<string, any> = {};
  for (const k of attrKeys) {
    if (bAttrs[k] !== cAttrs[k]) {
      cAttrDiff[k] = cAttrs[k];
      bAttrDiff[k] = bAttrs[k];
    }
  }
  if (Object.keys(cAttrDiff).length > 0) {
    changedProps.attributes = cAttrDiff;
    baselineProps.attributes = bAttrDiff;
  }

  // text (from #text children)
  const bText = nodeText(b), cText = nodeText(c);
  if (bText !== cText) {
    changedProps.text = cText;
    baselineProps.text = bText;
  }

  return { hasChanges: extraChanges > 0 || Object.keys(changedProps).length > 0, changedProps, baselineProps };
}

// Returns only the properties of `node` that differ from `against`.
// rect is always included.
function reducedProps(node: any, against: any): Record<string, any> {
  const result: Record<string, any> = {};

  result.rect = roundRect(node.rect); // always

  // style: only differing keys
  const nodeStyle = node.style ?? {}, againstStyle = against.style ?? {};
  const allStyleKeys = new Set([...Object.keys(nodeStyle), ...Object.keys(againstStyle)]);
  const styleDiff: Record<string, any> = {};
  for (const k of allStyleKeys) {
    if (nodeStyle[k] !== againstStyle[k]) styleDiff[k] = nodeStyle[k];
  }
  if (Object.keys(styleDiff).length > 0) result.style = styleDiff;

  // attributes: only differing keys
  const nodeAttrs = node.attributes ?? {}, againstAttrs = against.attributes ?? {};
  const allAttrKeys = new Set([...Object.keys(nodeAttrs), ...Object.keys(againstAttrs)]);
  const attrDiff: Record<string, any> = {};
  for (const k of allAttrKeys) {
    if (nodeAttrs[k] !== againstAttrs[k]) attrDiff[k] = nodeAttrs[k];
  }
  if (Object.keys(attrDiff).length > 0) result.attributes = attrDiff;

  // text
  const nt = nodeText(node), at = nodeText(against);
  if (nt !== at) result.text = nt;

  return result;
}

function roundRect(r: any): any {
  if (!r) return r;
  return {
    left: Math.round(r.left),
    top: Math.round(r.top),
    width: Math.round(r.width),
    height: Math.round(r.height),
  };
}

// Full node properties (no childNodes, text extracted from children)
function fullProps(node: any): Record<string, any> {
  const { childNodes, tagName, ...rest } = node;
  const result: Record<string, any> = { ...rest };
  if (result.rect) result.rect = roundRect(result.rect);
  const text = nodeText(node);
  if (text) result.text = text;
  return result;
}

// ---------------------------------------------------------------------------
// buildDiff
// ---------------------------------------------------------------------------

export function buildDiff(matches: Match[]): DiffNode[] {
  const result: DiffNode[] = [];

  for (const { b, c } of matches) {
    if (b && c) {
      const { hasChanges } = diffNodeProps(b.node, c.node);
      if (!hasChanges) continue; // unchanged: prune
      result.push({ status: 'changed', depth: c.depth, baselineNode: b.node, checkpointNode: c.node });
    } else if (c) {
      result.push({ status: 'new', depth: c.depth, baselineNode: null, checkpointNode: c.node });
    } else if (b) {
      result.push({ status: 'missing', depth: b.depth, baselineNode: b.node, checkpointNode: null });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// pruneReplacements (second pass)
// ---------------------------------------------------------------------------

const PAIR_THRESHOLD = 0.3;

export function pruneReplacements(diffs: DiffNode[]): (DiffNode | null)[] {
  function pairScore(a: any, b: any): number {
    if (!a || !b) return 0;
    return nodeSimilarity(a, b);
  }

  // Compute scope: the index of the nearest preceding 'changed' ancestor for each node.
  // Two nodes share a scope only when they are both descendants of the same matched ancestor
  // (or both have no matched ancestor, scope = -1). This limits candidate search to the
  // local subtree, avoiding O(k×n) global pairing on large pages with many unmatched nodes.
  const scope = new Array<number>(diffs.length).fill(-1);
  const scopeStack: { depth: number; index: number }[] = [];
  for (let i = 0; i < diffs.length; i++) {
    const d = diffs[i];
    while (scopeStack.length && scopeStack[scopeStack.length - 1].depth >= d.depth) scopeStack.pop();
    scope[i] = scopeStack.length ? scopeStack[scopeStack.length - 1].index : -1;
    if (d.status === 'changed') scopeStack.push({ depth: d.depth, index: i });
  }

  type Candidate = { nodeIdx: number; partnerIdx: number; score: number };
  const candidates: Candidate[] = [];

  for (let i = 0; i < diffs.length; i++) {
    const d = diffs[i];
    if (d.status !== 'new' && d.status !== 'missing') continue;

    // Reference node for 'd' (what we compare against the partner)
    const dRef = d.status === 'new' ? d.checkpointNode : d.baselineNode;

    for (let j = 0; j < diffs.length; j++) {
      if (i === j) continue;
      if (scope[i] !== scope[j]) continue;
      const p = diffs[j];

      // 'new' pairs with 'missing' or 'changed' (not other 'new')
      if (d.status === 'new' && p.status === 'new') continue;
      // 'missing' pairs with 'new' or 'changed' (not other 'missing')
      if (d.status === 'missing' && p.status === 'missing') continue;

      // Reference node for 'p' from 'd's perspective:
      // If 'd' is 'new', compare against 'p's old state (baseline for missing/changed)
      // If 'd' is 'missing', compare against 'p's new state (checkpoint for new/changed)
      let pRef: any;
      if (p.status === 'new') pRef = p.checkpointNode;
      else if (p.status === 'missing') pRef = p.baselineNode;
      else {
        // 'changed': use baseline when 'd' is 'new' (what replaced what), checkpoint when 'd' is 'missing'
        pRef = d.status === 'new' ? p.baselineNode : p.checkpointNode;
      }

      const score = pairScore(dRef, pRef);
      if (score >= PAIR_THRESHOLD) {
        candidates.push({ nodeIdx: i, partnerIdx: j, score });
      }
    }
  }

  // Greedy: sort by score descending, take best non-conflicting pairs
  candidates.sort((a, b) => b.score - a.score);

  const paired = new Set<number>();
  const result: (DiffNode | null)[] = diffs.map(d => ({ ...d }));

  for (const { nodeIdx, partnerIdx } of candidates) {
    if (paired.has(nodeIdx) || paired.has(partnerIdx)) continue;
    paired.add(nodeIdx);
    paired.add(partnerIdx);

    const d = result[nodeIdx] as DiffNode;
    const p = result[partnerIdx] as DiffNode;

    if (d.status === 'missing' && p.status === 'new') {
      // The element moved: merge into a single 'changed' node at the checkpoint position (new node's slot).
      // Nullify the missing node — its baseline slot is no longer needed.
      result[partnerIdx] = { status: 'changed', depth: p.depth, baselineNode: d.baselineNode, checkpointNode: p.checkpointNode };
      result[nodeIdx] = null;
    } else if (d.status === 'new' && p.status === 'missing') {
      // Same as above, roles reversed.
      result[nodeIdx] = { status: 'changed', depth: d.depth, baselineNode: p.baselineNode, checkpointNode: d.checkpointNode };
      result[partnerIdx] = null;
    } else {
      // (new/missing) paired with 'changed': use pairNode to reduce output props.
      let dPairNode: any;
      if (p.status === 'new') dPairNode = p.checkpointNode;
      else if (p.status === 'missing') dPairNode = p.baselineNode;
      else dPairNode = d.status === 'new' ? p.baselineNode : p.checkpointNode;

      let pPairNode: any;
      if (d.status === 'new') pPairNode = d.checkpointNode;
      else pPairNode = d.baselineNode;

      result[nodeIdx] = { ...d, pairNode: dPairNode };
      result[partnerIdx] = { ...p, pairNode: pPairNode };
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// condenseDisplacements (third pass)
// ---------------------------------------------------------------------------

function isPureDisplacement(node: DiffNode): boolean {
  if (node.status !== 'changed') return false;
  if (node.baselineNode.tagName !== node.checkpointNode.tagName) return false;
  const { changedProps } = diffNodeProps(node.baselineNode, node.checkpointNode);
  if (Object.keys(changedProps).length > 0) return false;
  const bR = node.baselineNode.rect, cR = node.checkpointNode.rect;
  if (!bR || !cR) return false;
  if (Math.abs(bR.width - cR.width) >= 1) return false;
  if (Math.abs(bR.height - cR.height) >= 1) return false;
  return true;
}

function getDisplacementDelta(node: DiffNode): { left: number; top: number } {
  const bR = node.baselineNode.rect, cR = node.checkpointNode.rect;
  return { left: cR.left - bR.left, top: cR.top - bR.top };
}

function deltaEquals(a: { left: number; top: number }, b: { left: number; top: number }): boolean {
  return Math.abs(a.left - b.left) < 1 && Math.abs(a.top - b.top) < 1;
}

function createDisplacedEntry(group: DiffNode[]): DisplacedEntry {
  let minDepth = Infinity;
  let cMinLeft = Infinity, cMinTop = Infinity, cMaxRight = -Infinity, cMaxBottom = -Infinity;
  let bMinLeft = Infinity, bMinTop = Infinity, bMaxRight = -Infinity, bMaxBottom = -Infinity;

  for (const node of group) {
    minDepth = Math.min(minDepth, node.depth);
    const cR = node.checkpointNode.rect;
    const bR = node.baselineNode.rect;
    cMinLeft = Math.min(cMinLeft, cR.left);
    cMinTop = Math.min(cMinTop, cR.top);
    cMaxRight = Math.max(cMaxRight, cR.left + cR.width);
    cMaxBottom = Math.max(cMaxBottom, cR.top + cR.height);
    bMinLeft = Math.min(bMinLeft, bR.left);
    bMinTop = Math.min(bMinTop, bR.top);
    bMaxRight = Math.max(bMaxRight, bR.left + bR.width);
    bMaxBottom = Math.max(bMaxBottom, bR.top + bR.height);
  }

  return {
    status: 'displaced',
    count: group.length,
    depth: minDepth,
    rect: { left: cMinLeft, top: cMinTop, width: cMaxRight - cMinLeft, height: cMaxBottom - cMinTop },
    baseline: { rect: { left: bMinLeft, top: bMinTop, width: bMaxRight - bMinLeft, height: bMaxBottom - bMinTop } },
  };
}

export function condenseDisplacements(diffs: (DiffNode | null)[]): (DiffNode | DisplacedEntry | null)[] {
  const result: (DiffNode | DisplacedEntry | null)[] = [];
  let i = 0;

  while (i < diffs.length) {
    const node = diffs[i];
    if (node === null || !isPureDisplacement(node)) {
      result.push(node);
      i++;
      continue;
    }

    const delta = getDisplacementDelta(node);
    let j = i + 1;
    while (j < diffs.length && diffs[j] !== null && isPureDisplacement(diffs[j] as DiffNode) && deltaEquals(getDisplacementDelta(diffs[j] as DiffNode), delta)) {
      j++;
    }

    const groupLen = j - i;
    if (groupLen >= 2) {
      result.push(createDisplacedEntry(diffs.slice(i, j) as DiffNode[]));
    } else {
      result.push(node);
    }
    i = j;
  }

  return result;
}

// ---------------------------------------------------------------------------
// collapseMissingSubtrees (fourth pass)
// ---------------------------------------------------------------------------

export function collapseMissingSubtrees(
  diffs: (DiffNode | DisplacedEntry | null)[],
): (DiffNode | DisplacedEntry | CollapsedMissingEntry | null)[] {
  const result: (DiffNode | DisplacedEntry | CollapsedMissingEntry | null)[] = [];
  let i = 0;

  while (i < diffs.length) {
    const item = diffs[i];

    if (item === null || item.status !== 'missing') {
      result.push(item);
      i++;
      continue;
    }

    const parent = item as DiffNode; // status === 'missing' → must be DiffNode
    const parentDepth = parent.depth;
    let j = i + 1;

    while (
      j < diffs.length &&
      diffs[j] !== null &&
      diffs[j]!.status === 'missing' &&
      (diffs[j] as DiffNode).depth > parentDepth
    ) {
      j++;
    }

    const groupLen = j - i;
    if (groupLen >= 2) {
      let minLeft = Infinity, minTop = Infinity, maxRight = -Infinity, maxBottom = -Infinity;
      for (let k = i; k < j; k++) {
        const r = (diffs[k] as DiffNode).baselineNode?.rect;
        if (r) {
          minLeft = Math.min(minLeft, r.left);
          minTop = Math.min(minTop, r.top);
          maxRight = Math.max(maxRight, r.left + r.width);
          maxBottom = Math.max(maxBottom, r.top + r.height);
        }
      }
      const attrs = parent.baselineNode?.attributes;
      result.push({
        status: 'missing',
        tagName: parent.baselineNode.tagName,
        depth: parentDepth,
        count: groupLen,
        ...(attrs && Object.keys(attrs).length > 0 ? { attributes: attrs } : {}),
        rect: { left: minLeft, top: minTop, width: maxRight - minLeft, height: maxBottom - minTop },
      });
      i = j;
    } else {
      result.push(item);
      i++;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// serializeDiff
// ---------------------------------------------------------------------------

export function serializeDiff(diffs: (DiffNode | DisplacedEntry | CollapsedMissingEntry | null)[]): string {
  const lines: string[] = [];

  for (const diff of diffs) {
    if (diff === null) continue;
    const indent = '  '.repeat(diff.depth);
    let obj: Record<string, any>;

    if (diff.status === 'displaced') {
      obj = { status: 'displaced', count: diff.count, rect: roundRect(diff.rect), baseline: { rect: roundRect(diff.baseline.rect) } };
    } else if (diff.status === 'changed') {
      const { changedProps, baselineProps } = diffNodeProps(diff.baselineNode, diff.checkpointNode);
      const tagChanged = diff.baselineNode.tagName !== diff.checkpointNode.tagName;
      obj = {
        status: 'changed',
        tagName: diff.checkpointNode.tagName,
        rect: roundRect(diff.checkpointNode.rect),  // always present
        ...changedProps,
        baseline: {
          ...(tagChanged ? { tagName: diff.baselineNode.tagName } : {}),
          rect: roundRect(diff.baselineNode.rect),  // always present
          ...baselineProps,
        },
      };
    } else if (diff.status === 'new') {
      const props = diff.pairNode
        ? reducedProps(diff.checkpointNode, diff.pairNode)
        : fullProps(diff.checkpointNode);
      obj = { status: 'new', tagName: diff.checkpointNode.tagName, ...props };
    } else if ('count' in diff) {
      // CollapsedMissingEntry: entire missing subtree collapsed into parent + count + union rect
      const attrs = diff.attributes && Object.keys(diff.attributes).length > 0 ? { attributes: diff.attributes } : {};
      obj = { status: 'missing', tagName: diff.tagName, count: diff.count, ...attrs, rect: roundRect(diff.rect) };
    } else {
      // DiffNode missing: single missing node
      const d = diff as DiffNode;
      const props = d.pairNode
        ? reducedProps(d.baselineNode, d.pairNode)
        : fullProps(d.baselineNode);
      obj = { status: 'missing', tagName: d.baselineNode.tagName, ...props };
    }

    lines.push(indent + JSON.stringify(obj));
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Top-level entry point
// ---------------------------------------------------------------------------

export function computeDomDiff(baselineRoot: any, checkpointRoot: any): string {
  const baselineFlat = flattenTree(baselineRoot);
  const checkpointFlat = flattenTree(checkpointRoot);
  const matches = lcsMatch(baselineFlat, checkpointFlat);
  const diffs = buildDiff(matches);
  const pruned = pruneReplacements(diffs);
  const condensed = condenseDisplacements(pruned);
  const collapsed = collapseMissingSubtrees(condensed);
  return serializeDiff(collapsed);
}
