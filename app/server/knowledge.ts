export function knowledgeMetadata(value: { knowledgePoints?: unknown; designLogic?: unknown }) {
  const points = Array.isArray(value.knowledgePoints) ? value.knowledgePoints : [];
  const knowledgePoints = [...new Set(points.filter((point): point is string =>
    typeof point === 'string' && point.trim().length > 0 && point.trim().length <= 80
  ).map(point => point.normalize('NFKC').trim()))].slice(0, 8);
  const designLogic = typeof value.designLogic === 'string' ? value.designLogic.trim().slice(0, 1000) : '';
  return { knowledgePoints, designLogic };
}

export function buildKnowledgeNetwork(questions: { modelSolution?: {
  knowledgePoints?: unknown; designLogic?: unknown; rationale?: unknown
} | null }[]) {
  const nodes = new Map<string, number[]>();
  const edges = new Map<string, { from: string; to: string; questions: number[] }>();
  const questionLogic: { number: number; text: string }[] = [];
  for (const [index, question] of questions.entries()) {
    if (!question.modelSolution) continue;
    const solution = question.modelSolution;
    const { knowledgePoints, designLogic } = knowledgeMetadata(solution);
    const points = knowledgePoints.sort();
    const number = index + 1;
    const logic = designLogic || (typeof solution.rationale === 'string' ? solution.rationale : '');
    if (logic) questionLogic.push({ number, text: logic });
    for (const [position, from] of points.entries()) {
      const occurrences = nodes.get(from) ?? [];
      occurrences.push(number);
      nodes.set(from, occurrences);
      for (const to of points.slice(position + 1)) {
        const key = JSON.stringify([from, to]);
        const edge = edges.get(key) ?? { from, to, questions: [] };
        edge.questions.push(number);
        edges.set(key, edge);
      }
    }
  }
  return { nodes: [...nodes].map(([label, questions]) => ({ label, questions })),
    edges: [...edges.values()], questionLogic };
}
