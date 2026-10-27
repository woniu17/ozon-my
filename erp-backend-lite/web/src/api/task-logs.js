// 定时任务执行日志 API(2026-10-27)
import { get } from './request.js';

// 任务定义列表(名称/级别/频率)
export function getTaskLogTasks() {
  return get('/admin/api/task-logs/tasks');
}

// 每个任务最近一次执行(概览卡)
export function getTaskLogLatest(level) {
  return get('/admin/api/task-logs/latest', { level });
}

// 分页查询执行日志
// params: { level, task, status, from, to, keyword, page, pageSize }
export function getTaskLogs(params) {
  return get('/admin/api/task-logs', params);
}