// 进程内互斥队列 + 超时包装(2026-09,平台订单获取 M1)
// 单浏览器串行:cloakbrowser 同一 userDataDir 不允许双开,所有平台订单任务
// 排队先到先得执行,避免并发 evaluate 互相干扰
//
// 设计文档: docs/平台订单获取后端化-概要设计.md §3.1(并发模型:进程内互斥队列)

/** 串行队列:任务按到达顺序执行,前序失败不阻断后序 */
export class SerialQueue {
  constructor() {
    this._tail = Promise.resolve();
  }

  /** 提交任务,返回其结果 Promise;任务内部抛错原样透传给调用方 */
  run(fn) {
    const job = this._tail.then(() => fn());
    // 链尾吞错,保证后续任务不受前序失败影响
    this._tail = job.then(() => undefined, () => undefined);
    return job;
  }
}

/** 超时包装:超时 reject 的错误带 kind='timeout',调用方据此回收浏览器 */
export function withTimeout(promise, ms, label) {
  let timer = null;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${label}超时(${ms}ms),已回收浏览器`);
      err.kind = 'timeout';
      reject(err);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
