// 一次性探测:unfulfilled list 在途单的 status/substatus 实际形态(验证取货点兜底可行性)
import config from '../src/config/index.js';
import { postingFbsUnfulfilledList } from '../src/services/ozon-opi.js';

async function main() {
  const stores = (config.loadStores() || []).filter((s) => s?.sync_credentials?.clientId).slice(0, 2);
  for (const store of stores) {
    try {
      const resp = await postingFbsUnfulfilledList(store, { cutoffFrom: new Date(Date.now() - 7 * 86400_000).toISOString(), cutoffTo: new Date(Date.now() + 14 * 86400_000).toISOString() });
      const postings = resp?.result?.postings || resp?.postings || [];
      const dist = new Map();
      for (const p of postings) {
        const k = `${p.status} | sub=${p.substatus ?? '(null)'}`;
        dist.set(k, (dist.get(k) || 0) + 1);
      }
      console.log(`== ${store.name} (${postings.length} 单) ==`);
      [...dist.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, n]) => console.log(' ', k, ':', n));
    } catch (e) {
      console.log(`== ${store.name} 拉取失败: ${e.message}`);
    }
  }
}
main();
