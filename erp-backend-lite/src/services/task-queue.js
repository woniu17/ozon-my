// 简单内存任务队列(替代 BullMQ)
// 用于 prepare-bundle-items / import 等长任务
import { randomUUID } from 'node:crypto';
import logger from '../middleware/log.js';

const jobs = new Map(); // id → { id, type, status, payload, result, error, createdAt, updatedAt }

export function createJob(type, payload) {
  const id = randomUUID();
  const job = {
    id,
    type,
    status: 'pending',
    payload,
    result: null,
    error: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  jobs.set(id, job);
  return job;
}

export function getJob(id) {
  return jobs.get(id) || null;
}

export function updateJob(id, patch) {
  const job = jobs.get(id);
  if (!job) return null;
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });
  return job;
}

// 后台执行(不阻塞响应)
export function runAsync(id, fn) {
  updateJob(id, { status: 'processing' });
  Promise.resolve()
    .then(() => fn())
    .then((result) => {
      updateJob(id, { status: 'done', result });
      logger.info({ jobId: id, type: getJob(id)?.type }, 'job done');
    })
    .catch((err) => {
      updateJob(id, { status: 'failed', error: err?.message || String(err) });
      logger.warn({ jobId: id, err: err?.message }, 'job failed');
    });
}

// 清理 24h 前的已完成任务,避免内存泄漏
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
setInterval(
  () => {
    const now = Date.now();
    for (const [id, job] of jobs) {
      if (job.status === 'done' || job.status === 'failed') {
        const updated = new Date(job.updatedAt).getTime();
        if (now - updated > ONE_DAY_MS) jobs.delete(id);
      }
    }
  },
  60 * 60 * 1000
).unref();
