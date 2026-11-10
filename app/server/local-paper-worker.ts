import { settleExpiredPractices } from './practice.js';
import { processNextPrediction } from './predictions.js';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { processNextSolution, solutionEndpoint } from './model-solution.js';
import { processNextPageRecognition } from './pdf-page-recognition.js';
import { processNextPaper } from './paper-worker.js';

if (!process.env.LOCAL_PAPER_WORKER_DATABASE_URL) throw new Error('LOCAL_PAPER_WORKER_DATABASE_URL is required');
const modelsEnabled = process.env.BEITIBAO_ENABLE_MODELS === '1';
const predictionsEnabled = modelsEnabled && process.env.BEITIBAO_ENABLE_PREDICTIONS !== '0';
if (modelsEnabled && !solutionEndpoint()) throw new Error('Local model recognition credentials are required');
const pageConcurrency = modelsEnabled ? 6 : 1;
const solutionConcurrency = modelsEnabled ? 4 : 1;
const pool = new pg.Pool({ connectionString: process.env.LOCAL_PAPER_WORKER_DATABASE_URL, max: pageConcurrency + solutionConcurrency + 2 });
let running = true;
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { running = false; });

async function runLane(name: string, work: () => Promise<unknown>) {
  while (running) {
    try {
      if (!await work()) await delay(1000);
    } catch {
      console.error('LOCAL_PAPER_WORKER_ERROR', name);
      await delay(2000);
    }
  }
}

try {
  await Promise.all([
    runLane('paper', () => processNextPaper(pool, undefined, undefined, { modelsEnabled, predictionsEnabled }, undefined, modelsEnabled)),
    ...(modelsEnabled ? [
      ...Array.from({ length: pageConcurrency }, () => runLane('page', () => processNextPageRecognition(pool, undefined, undefined, undefined, true, predictionsEnabled))),
      ...Array.from({ length: solutionConcurrency }, () => runLane('solution', async () => solutionEndpoint() && await processNextSolution(pool)))
    ] : []),
    ...(predictionsEnabled ? [runLane('prediction', () => processNextPrediction(pool))] : []),
    runLane('deadline', async () => { await settleExpiredPractices(pool); })
  ]);
} finally {
  await pool.end();
}
