// 一次性排查:拼多多采购单 260920-134322645283751 订单详情 + 物流轨迹(79143025627789)
import { searchPddOrder, getPddTrace } from '../src/services/platform-orders/adapters/pdd.js';

const orderSn = '260920-134322645283751';
const userTracking = '79143025627789';

async function main() {
  console.log('== 1) 平台订单搜索 ==');
  try {
    const { result } = await searchPddOrder(orderSn, ['linqx']);
    if (!result) {
      console.log('未找到订单');
    } else {
      console.log(JSON.stringify(result, null, 1).slice(0, 1500));
    }
  } catch (e) {
    console.log('搜索失败:', e.message);
  }

  console.log('\n== 2) 物流轨迹(用户提供的单号', userTracking + ') ==');
  try {
    const t = await getPddTrace(orderSn, userTracking, 'linqx');
    console.log('快递公司:', t.shippingName);
    console.log('轨迹节点', t.steps.length, '条(最新在前):');
    t.steps.slice(0, 15).forEach((s) => console.log(' ', s.acceptTime, '|', s.remark));
  } catch (e) {
    console.log('轨迹查询失败:', e.message);
  }
}
main();
