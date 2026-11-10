import type { Pool } from 'pg';
import { dispatchBusinessJob, consumeBusinessJob, type BusinessLane, type JobTarget } from './job-outbox.js';
import { processNextPaper } from './paper-worker.js';
import { processNextPageRecognition } from './pdf-page-recognition.js';
import { processNextSolution } from './model-solution.js';
import { processNextPrediction } from './predictions.js';
import { consumePracticeDeadline, settleExpiredPractices } from './practice.js';
import { dispatchPracticeDeadline } from './practice-deadline.js';
import type { WorkQueue } from './smq.js';
import type { PaperStorage } from './paper-storage.js';

type Settings = { storage: PaperStorage; modelsEnabled: boolean; predictionsEnabled: boolean };

async function drainQueue(queue: WorkQueue | null, dispatch: (queue: WorkQueue) => Promise<boolean>,
  consume: ((eventId: string) => Promise<boolean>) | null) {
  let dispatched = 0;
  let acknowledged = 0;
  if (!queue) return { dispatched, acknowledged };
  const started = Date.now();
  try {
    for (let i = 0; i < (consume ? 12 : 100) && Date.now() - started < (consume ? 8000 : 20_000); i++) {
      if (!await dispatch(queue)) break;
      dispatched++;
    }
    for (let i = 0; consume && i < 8 && Date.now() - started < 12_000; i++) {
      const message = await queue.receive();
      if (!message) break;
      if (!message.eventId) {
        console.warn(JSON.stringify({ code: 'WORK_QUEUE_INVALID_MESSAGE' }));
        continue;
      }
      if (await consume(message.eventId)) {
        await queue.ack(message.receipt);
        acknowledged++;
      }
    }
  } catch {
    console.warn(JSON.stringify({ code: 'WORK_QUEUE_TEMPORARILY_UNAVAILABLE' }));
  }
  return { dispatched, acknowledged };
}

function businessWorker(pool: Pool, lane: BusinessLane, settings: Settings) {
  const work: Record<BusinessLane, (target?: JobTarget) => Promise<boolean>> = {
    paper: target => processNextPaper(pool, undefined, undefined, settings, target),
    page: target => processNextPageRecognition(pool, undefined, settings.storage, target, true, settings.predictionsEnabled),
    solution: target => processNextSolution(pool, undefined, settings.storage, target),
    prediction: target => processNextPrediction(pool, undefined, target)
  };
  return lane === 'paper' || (settings.modelsEnabled && (lane !== 'prediction' || settings.predictionsEnabled))
    ? work[lane] : null;
}

export async function runBusinessEvent(pool: Pool, lane: BusinessLane, eventId: string, settings: Settings) {
  const work = businessWorker(pool, lane, settings);
  return Boolean(work && await consumeBusinessJob(pool, lane, eventId, work));
}

export async function runBusinessBatch(pool: Pool, lane: BusinessLane, queue: WorkQueue | null, settings: Settings,
  pushDelivery = false) {
  const work = businessWorker(pool, lane, settings);
  if (!work) return { dispatched: 0, acknowledged: 0, recovered: false };
  let processed = false;
  const result = await drainQueue(queue, smq => dispatchBusinessJob(pool, lane, event => smq.publish(event)),
    pushDelivery ? null : async eventId => consumeBusinessJob(pool, lane, eventId, async target => {
      const worked = await work(target);
      processed ||= worked;
      return worked;
    }));
  // The database queue can also resume migrated jobs, expired leases, and deliveries that reached a dead letter queue.
  const recovered = !processed && await work();
  return { ...result, recovered };
}

export async function runPracticeBatch(pool: Pool, queue: WorkQueue | null, pushDelivery = false) {
  await settleExpiredPractices(pool);
  return drainQueue(queue, smq => dispatchPracticeDeadline(pool, (event, seconds) => smq.publish(event, seconds)),
    pushDelivery ? null : eventId => consumePracticeDeadline(pool, eventId));
}
