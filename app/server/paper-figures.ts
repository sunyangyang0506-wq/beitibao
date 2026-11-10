import sharp from 'sharp';

type Box = [number, number, number, number];
type Edge = { from: string; to: string; label: string };
type Reading = { kind: 'directed' | 'undirected' | 'tree' | 'other'; nodes: string[]; edges: Edge[]; description: string };
export type PaperFigure = {
  box: Box | null;
  initial: Reading | null;
  reread: Reading | null;
  status: 'consistent' | 'needs_review';
  manualReread?: boolean;
  inferredSides?: number;
  reason?: 'location' | 'budget' | 'unreadable' | 'conflict' | 'structure' | 'manual';
  previous?: Pick<PaperFigure, 'box' | 'initial' | 'reread' | 'status' | 'reason'>;
};

export function figureBox(value: unknown): Box | null {
  if (!Array.isArray(value) || value.length !== 4
      || !value.every(n => Number.isInteger(n) && n >= 0 && n <= 1000)) return null;
  const [left, top, right, bottom] = value as Box;
  return right - left >= 10 && bottom - top >= 10 ? [left, top, right, bottom] : null;
}

export function figureWithinQuestion(box: Box, question: Box | null | undefined) {
  if (!question) return true;
  const tolerance = 15;
  return box[0] >= question[0] - tolerance && box[1] >= question[1] - tolerance &&
    box[2] <= question[2] + tolerance && box[3] <= question[3] + tolerance;
}

function shortText(value: unknown, max: number) {
  return typeof value === 'string' && value.length <= max && !value.includes('\u0000') ? value.trim() : null;
}

export function figureReading(value: unknown): Reading | null {
  if (!value || typeof value !== 'object') return null;
  const { kind, nodes, edges, description } = value as Reading;
  const detail = shortText(description, 2400);
  if (detail === null || !['directed', 'undirected', 'tree', 'other'].includes(kind)
      || !Array.isArray(nodes) || nodes.length > 100 || !Array.isArray(edges) || edges.length > 200) return null;
  const names = nodes.map(node => shortText(node, 80));
  if (names.some(name => !name) || new Set(names).size !== names.length) return null;
  if (kind === 'other') return detail && !nodes.length && !edges.length ? { kind, nodes: [], edges: [], description: detail } : null;
  if (names.length < 2 || !edges.length) return null;
  const ids = new Set(names);
  const links = new Set<string>();
  const incoming = new Set<string>();
  const children = new Map<string, string[]>();
  for (const edge of edges) {
    if (!edge || !ids.has(edge.from) || !ids.has(edge.to) || shortText(edge.label, 80) === null) return null;
    const ends = kind === 'undirected' ? [edge.from, edge.to].sort() : [edge.from, edge.to];
    const key = JSON.stringify(ends);
    if (links.has(key)) return null;
    links.add(key);
    if (kind === 'tree') {
      if (incoming.has(edge.to) || !['left', 'middle', 'right', 'child'].includes(edge.label)) return null;
      incoming.add(edge.to);
      const siblings = children.get(edge.from) ?? [];
      if (edge.label !== 'child' && edges.filter(link => link?.from === edge.from && link?.label === edge.label).length > 1) return null;
      children.set(edge.from, [...siblings, edge.to]);
    }
  }
  if (kind === 'tree') {
    const roots = nodes.filter(node => !incoming.has(node));
    if (roots.length !== 1 || edges.length !== nodes.length - 1) return null;
    const visited = new Set<string>();
    const pending = [...roots];
    while (pending.length) {
      const node = pending.pop()!;
      if (visited.has(node)) return null;
      visited.add(node);
      pending.push(...(children.get(node) ?? []));
    }
    if (visited.size !== nodes.length) return null;
  }
  return { kind, nodes, edges: edges.map(({ from, to, label }) => ({ from, to, label: label.trim() })), description: detail };
}

function readingKey(reading: Reading) {
  if (reading.kind === 'other') return reading.description.normalize('NFKC').replace(/\s+/gu, '');
  return JSON.stringify([reading.kind, [...reading.nodes].sort(), reading.edges.map(({ from, to, label }) => {
    const ends = reading.kind === 'undirected' ? [from, to].sort() : [from, to];
    return JSON.stringify([...ends, label]);
  }).sort()]);
}

export function isNumericSearchTree(stem: string, reading: Reading | null) {
  return reading?.kind === 'tree' &&
    /\b(?:AVL|BST|binary\s*search\s*tree)\b|árbol binario de búsqueda|二[叉元](?:搜索|搜尋)[树樹]/iu.test(stem) &&
    reading.nodes.every(node => /^-?\d+$/.test(node));
}

function checkSearchTree(stem: string, reading: Reading) {
  if (!isNumericSearchTree(stem, reading)) return { reading, inferredSides: 0 };

  const keys = new Map(reading.nodes.map(node => [node, BigInt(node)]));
  if (new Set(keys.values()).size !== keys.size) return null;
  let inferredSides = 0;
  const edges = reading.edges.map(edge => {
    if (edge.label !== 'child') return edge;
    inferredSides++;
    return { ...edge, label: keys.get(edge.to)! < keys.get(edge.from)! ? 'left' : 'right' };
  });
  const slots = new Set(edges.map(edge => JSON.stringify([edge.from, edge.label])));
  if (slots.size !== edges.length) return null;
  const parents = new Map(edges.map(edge => [edge.to, edge]));
  for (const [node, key] of keys) {
    let edge = parents.get(node);
    while (edge) {
      const parent = keys.get(edge.from)!;
      if ((edge.label === 'left' && key >= parent) || (edge.label === 'right' && key <= parent)
          || edge.label === 'middle') return null;
      edge = parents.get(edge.from);
    }
  }
  return { reading: { ...reading, edges }, inferredSides };
}

export function compareFigure(figure: PaperFigure, reread: Reading | null, stem = ''): PaperFigure {
  const pending = { ...figure, status: 'needs_review' as const };
  if (!reread) return { ...pending, reason: 'unreadable' };
  const checked = checkSearchTree(stem, reread);
  if (!checked) return { ...pending, reread, reason: 'structure' };
  const { reading, inferredSides } = checked;
  const fields = { ...pending, reread: reading, ...(inferredSides ? { inferredSides } : {}) };
  const initial = figure.initial && checkSearchTree(stem, figure.initial);
  if (!initial || readingKey(initial.reading) !== readingKey(reading)) {
    return { ...fields, reason: 'conflict' };
  }
  const { reason: _reason, ...consistent } = fields;
  return { ...consistent, status: 'consistent' };
}

export function figureText(reading: Reading | null) {
  if (!reading) return '';
  if (reading.kind === 'other') return reading.description;
  return [
    `图类型 ${reading.kind}，节点 ${reading.nodes.join('、')}`,
    ...reading.edges.map(({ from, to, label }) => `${from} ${reading.kind === 'undirected' ? '—' : '→'} ${to}${label ? ` (${label})` : ''}`),
    reading.description
  ].filter(Boolean).join('\n');
}

export async function cropOriginal(bytes: Buffer, box: Box) {
  const original = sharp(bytes, { limitInputPixels: 25_000_000 });
  const { width, height } = (await original.metadata()).autoOrient;
  if (!width || !height) throw new Error('INVALID_IMAGE_SIZE');
  const [x1, y1, x2, y2] = box;
  // Leave a narrow margin around arrows and labels, keeping native resolution.
  const margin = (span: number) => Math.min(8, span * 0.035);
  const dx = margin(x2 - x1);
  const dy = margin(y2 - y1);
  const left = Math.max(0, Math.floor(width * (x1 - dx) / 1000));
  const top = Math.max(0, Math.floor(height * (y1 - dy) / 1000));
  const right = Math.min(width, Math.ceil(width * (x2 + dx) / 1000));
  const bottom = Math.min(height, Math.ceil(height * (y2 + dy) / 1000));
  return original.autoOrient().extract({ left, top, width: right - left, height: bottom - top })
    .resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
}
