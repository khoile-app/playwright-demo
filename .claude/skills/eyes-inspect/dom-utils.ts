import { type Rect, rectsIntersect, rectContains } from './rect-utils';

/**
 * Extracts the bounding rect from an Applitools DOM snapshot node.
 * Returns null if the node has no rect or its values are not numbers.
 */
export function nodeRect(node: any): Rect | null {
  const r = node?.rect;
  if (!r) return null;
  const { left, top, width, height } = r;
  if (
    typeof left !== 'number' || typeof top !== 'number' ||
    typeof width !== 'number' || typeof height !== 'number'
  ) return null;
  return { left, top, width, height };
}

/**
 * How many times larger than the tightest container an ancestor's area may be
 * before it is reduced to a summary node (tagName + attributes only).
 * Ancestors within this factor are kept in full because they are likely part of
 * the direct component structure immediately surrounding the diff.
 */
const ANCESTOR_SIMILARITY_FACTOR = 5;

function isWhitespaceTextNode(node: any): boolean {
  return node?.tagName === '#text' && /^\s*$/.test(node.text ?? '');
}

function stripWhitespaceNodes(node: any): any {
  if (!node || typeof node !== 'object' || !node.childNodes) return node;
  const children = (node.childNodes as any[])
    .filter(c => !isWhitespaceTextNode(c))
    .map(stripWhitespaceNodes);
  return { ...node, childNodes: children };
}

type PruneResult = {
  nodes: any[];
  /** Pixel area of the tightest container in this subtree, or 0 if none found. */
  tightestContainerArea: number;
};

/**
 * Internal recursive implementation. Returns the pruned node alongside the pixel area
 * of the tightest container found in the subtree, so ancestors can decide whether they
 * are "similar in size" and should be kept in full, or are distant and should be summarised.
 */
function pruneDomTreeInternal(node: any, area: Rect): PruneResult {
  if (!node) return { nodes: [], tightestContainerArea: 0 };

  // Non-element nodes (text "#text", comment "#comment", etc.) have no rect.
  // Pass them through — they survive only if their parent element is retained.
  if (!node.tagName || node.tagName.startsWith('#')) return { nodes: [node], tightestContainerArea: 0 };

  // Process children. Only retained element children vote on retention; text nodes
  // ride along. Track the largest tightestContainerArea reported by any child.
  let retainedElementCount = 0;
  const prunedChildren: any[] = [];
  let childTightestArea = 0;

  for (const child of (node.childNodes ?? [])) {
    if (child?.tagName && !child.tagName.startsWith('#')) {
      const result = pruneDomTreeInternal(child, area);
      if (result.nodes.length > 0) {
        prunedChildren.push(...result.nodes);
        retainedElementCount++;
        if (result.tightestContainerArea > childTightestArea) {
          childTightestArea = result.tightestContainerArea;
        }
      }
    } else {
      if (child != null && !isWhitespaceTextNode(child)) prunedChildren.push(child);
    }
  }

  const r = nodeRect(node);
  const selfIntersects = r !== null && rectsIntersect(r, area);

  if (!selfIntersects && retainedElementCount === 0) return { nodes: [], tightestContainerArea: 0 };

  const nodeArea = r !== null ? r.width * r.height : 0;
  const diffArea = area.width * area.height;

  // A "container" strictly contains the area and is larger (equal-size nodes are
  // treated as directly intersecting via selfIntersects above).
  const isContainer = r !== null && rectContains(r, area) && nodeArea > diffArea;

  // The "tightest container" is the innermost one: it contains the area but no
  // retained child does. This is the most useful ancestor for source code correlation.
  const isTightestContainer = isContainer && childTightestArea === 0;

  const tightestContainerArea = isTightestContainer ? nodeArea : childTightestArea;

  // Nodes that overlap the diff area without fully containing it are treated as direct
  // neighbours of the change and always kept in full (rule 1).
  // Nodes that contain the diff area may still be summarised if they are large enough.
  const overlapsWithoutContaining = selfIntersects && !isContainer;

  // A node is a distant ancestor when:
  //   - not a direct neighbour (overlaps without containing)
  //   - not the tightest container
  //   - either has no meaningful pixel area, or is much larger than the tightest container
  // Distant ancestors are skipped entirely; their retained children are promoted up.
  const isDistantAncestor = !overlapsWithoutContaining &&
    !isTightestContainer &&
    (nodeArea === 0 || (tightestContainerArea > 0 && nodeArea > ANCESTOR_SIMILARITY_FACTOR * tightestContainerArea));

  if (isDistantAncestor) {
    return { nodes: prunedChildren, tightestContainerArea };
  }

  return { nodes: [{ ...node, childNodes: prunedChildren }], tightestContainerArea };
}

/**
 * Recursively prunes a DOM tree to only the branches relevant to the given area.
 *
 * Retention rules:
 *   1. Nodes that overlap the area without fully containing it get full detail — they are
 *      direct neighbours of the change.
 *   2. The tightest container (innermost ancestor whose rect strictly contains the area,
 *      with no retained child also containing it) gets full detail.
 *   3. Ancestors within ANCESTOR_SIMILARITY_FACTOR× the tightest container's pixel area
 *      get full detail — they are likely part of the immediate component structure.
 *   4. All other (distant) ancestors are skipped entirely; their retained children are
 *      promoted up, so the output starts at the innermost relevant node.
 *   - Text/comment nodes ("#text", "#comment") are passed through with their parent.
 *   - Returns null if no node in the tree intersects the area.
 */
export function pruneDomTree(node: any, area: Rect): any | null {
  const { nodes } = pruneDomTreeInternal(node, area);
  if (nodes.length === 0) return null;
  if (nodes.length === 1) return nodes[0];
  return nodes;
}

/**
 * Validates that a domId is usable. Returns an error string if not, null if valid.
 * Guards against passing the literal string "null" copied from `info` JSON output.
 */
export function validateDomId(domId: string | null | undefined): string | null {
  if (!domId || domId === 'null') {
    return 'This step has no DOM capture (domId is null). DOM snapshots are only available for steps captured with the Applitools SDK DOM capture feature enabled.';
  }
  return null;
}

// Top-level fields in the Applitools DOM snapshot that are metadata, not part of the DOM tree.
// css/images/version are root-only fields; stripping them keeps output focused on structure.
const METADATA_FIELDS = new Set(['css', 'images', 'version', 'scriptVersion']);

/**
 * Returns a clean DOM output from a raw Applitools DOM snapshot.
 *
 * The tree structure is always preserved so the model can:
 *   - Detect differences at the code level (not just pixel level)
 *   - Correlate DOM nodes to UI source code components via tagName/attributes/hierarchy
 *
 * - Without area: returns the full tree with top-level metadata stripped.
 * - With area: returns a pruned subtree rooted at the innermost relevant node —
 *   distant ancestors are omitted. Returns null if no node intersects the area.
 */
export function prepareDomOutput(snapshot: any, area?: Rect): any {
  if (!snapshot) return null;

  // Strip top-level metadata fields that are not part of the DOM tree
  const rootNode: any = {};
  for (const [k, v] of Object.entries(snapshot)) {
    if (!METADATA_FIELDS.has(k)) rootNode[k] = v;
  }

  if (!area) return stripWhitespaceNodes(rootNode);

  return pruneDomTree(rootNode, area);
}
