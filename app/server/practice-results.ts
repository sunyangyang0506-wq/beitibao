import { isDeepStrictEqual } from 'node:util';
import type { PoolClient } from 'pg';
import type { buildKnowledgeNetwork } from './knowledge.js';
import { gradePracticeAnswer, type ModelGradingSolution, type QuestionReference } from './question-reference.js';

export type PracticeQuestion = {
  id: string; stem: string; inputRevision?: number; kind?: string; visualReview?: string | null; reference?: QuestionReference | null;
};
export type SolutionSnapshot = {
  stem: string;
  input_revision?: number;
  visual_review: string | null;
  model_solution: (ModelGradingSolution & NonNullable<Parameters<typeof buildKnowledgeNetwork>[0][number]['modelSolution']>) | null;
  solution_status: string | null;
};
export type CurrentPracticeSolution = SolutionSnapshot & {
  id: string; question_kind: string; reference: QuestionReference | null;
};
export type Grades = Record<string, ReturnType<typeof gradePracticeAnswer>>;
type StoredPracticeResult = {
  questions: PracticeQuestion[];
  answers: Record<string, string>;
  graded: Grades;
  solution_snapshots: Record<string, SolutionSnapshot> | null;
};

export function gradePracticeQuestion(attempt: Pick<StoredPracticeResult, 'answers'>,
  question: PracticeQuestion, snapshot?: SolutionSnapshot) {
  return gradePracticeAnswer(attempt.answers[question.id], question.reference, question.kind, question.stem, snapshot?.model_solution);
}

export function samePracticeInput(question: PracticeQuestion, solution: CurrentPracticeSolution) {
  return (question.inputRevision ?? 1) === (solution.input_revision ?? 1) && question.stem === solution.stem && (question.visualReview ?? null) === solution.visual_review
    && (question.kind === undefined || question.kind === solution.question_kind)
    && isDeepStrictEqual(question.reference ?? null, solution.reference);
}

// Only fill a missing solution for the same original input. A completed snapshot is immutable.
export function reconcilePracticeResult(saved: StoredPracticeResult, current: CurrentPracticeSolution[]) {
  if (saved.solution_snapshots === null) return null;
  const snapshots = { ...saved.solution_snapshots };
  const grades = { ...saved.graded };
  const byId = new Map(current.map(solution => [solution.id + ':' + (solution.input_revision ?? 1), solution]));
  let changed = false;
  for (const question of saved.questions) {
    let snapshot = snapshots[question.id];
    const solution = byId.get(question.id + ':' + (question.inputRevision ?? 1));
    if (!snapshot) continue;
    if (!snapshot.model_solution && solution?.model_solution
        && snapshot.stem === solution.stem && snapshot.visual_review === solution.visual_review
        && samePracticeInput(question, solution)) {
      snapshot = { ...snapshot, model_solution: solution.model_solution, solution_status: solution.solution_status };
      snapshots[question.id] = snapshot;
      changed = true;
    }
    if (grades[question.id] === 'needs_review' || grades[question.id] === undefined) {
      const grade = gradePracticeQuestion(saved, question, snapshot);
      if (grade !== grades[question.id]) {
        grades[question.id] = grade;
        changed = true;
      }
    }
  }
  return changed ? { snapshots, grades } : null;
}

// Current and archived attempts share the same fill-once reconciliation. A frozen
// question revision may supply an already-generated answer to a draft that was
// submitted after the question was corrected. It cannot acquire a newer answer.
export const practiceSolutionSources = `
  SELECT q.id,q.paper_id,q.stem,q.input_revision,q.visual_review,q.question_kind,q.reference,q.model_solution,q.solution_status
  FROM paper_questions q WHERE q.tenant_id=$1 AND NOT q.figure_review_blocked
  UNION ALL
  SELECT h.question_id,(h.question->>'paper_id')::uuid,h.question->>'stem',h.input_revision,
    h.question->>'visual_review',h.question->>'question_kind',nullif(h.question->'reference','null'::jsonb),
    nullif(h.question->'model_solution','null'::jsonb),h.question->>'solution_status'
  FROM question_revision_history h WHERE h.tenant_id=$1
    AND NOT coalesce((h.question->>'figure_review_blocked')::boolean, false)
`;

export async function refreshPracticeResults(db: PoolClient, tenant: string, filter: { paperId?: string; questionId?: string } = {}) {
  for (const archived of [false, true]) {
    const table = archived ? 'practice_history' : 'practice_results';
    const { rows } = await db.query<StoredPracticeResult & { paper_id: string; history_id: string | null; current_solutions: CurrentPracticeSolution[] }>(`
      SELECT r.paper_id, ${archived ? 'r.id' : 'NULL::uuid'} AS history_id, r.graded, r.solution_snapshots, a.questions, a.answers,
        (SELECT coalesce(jsonb_agg(to_jsonb(source)), '[]'::jsonb) FROM (${practiceSolutionSources}) source
          WHERE source.paper_id=r.paper_id) AS current_solutions
      FROM ${table} r
      ${archived ? 'CROSS JOIN LATERAL (SELECT r.questions, r.answers, r.submitted_at) a' : 'JOIN practice_attempts a ON (a.tenant_id,a.paper_id)=(r.tenant_id,r.paper_id)'}
      WHERE r.tenant_id=$1 AND ($2::uuid IS NULL OR r.paper_id=$2)
        AND ($3::uuid IS NULL OR r.solution_snapshots ? $3::text)
        AND a.submitted_at IS NOT NULL AND r.solution_snapshots IS NOT NULL
        AND EXISTS (SELECT 1 FROM jsonb_each(r.solution_snapshots) snapshot
          WHERE r.graded->>snapshot.key='needs_review' OR snapshot.value->'model_solution'='null'::jsonb)
      ORDER BY r.paper_id ${archived ? ', r.id' : ''} FOR UPDATE OF r
    `, [tenant, filter.paperId ?? null, filter.questionId ?? null]);
    for (const saved of rows) {
      const result = reconcilePracticeResult({ ...saved, graded: saved.graded ?? {} }, saved.current_solutions);
      if (result) await db.query(`UPDATE ${table} SET solution_snapshots=$3,graded=$4
        WHERE tenant_id=$1 AND ${archived ? 'id' : 'paper_id'}=$2`,
      [tenant, saved.history_id ?? saved.paper_id, JSON.stringify(result.snapshots), JSON.stringify(result.grades)]);
    }
  }
}

export function modelGradingBasisChanged(reference: QuestionReference | null,
  original: ModelGradingSolution | null | undefined, current: ModelGradingSolution | null | undefined) {
  // Teacher/verified references take precedence over model output. Explanation-only edits
  // do not change a grade, but removing or replacing the model answer invalidates a retry.
  return !reference && Boolean(original) && (original?.status !== current?.status || original?.answer !== current?.answer);
}
