// 发运货运标签打印/预览(2026-10-31,自 web 端 print-agent.js 移植)
// 与 Web 不同:小程序/H5 环境无「本机菜鸟组件」,统一走服务器组件直打与服务器渲染预览:
// - 预览:/admin/api/print-agent/preview-container-label → { images: [dataUrl,...] }(服务器渲染实际出纸 PNG)
// - 打印:/admin/api/print-agent/print-container-label(服务器拉 PDF → 渲染 → 转发打印组件出纸)
// - 打印状态:/admin/api/print-agent/container-label-print-status → { printed: { id: bool } }
import { get, post } from './request.js';

// 货运标签服务端多页预览(不依赖本机组件,返回 { images: [dataUrl,...], labelId })
export function getContainerLabelPreview(storeId, labelId) {
  return post('/admin/api/print-agent/preview-container-label', { storeId, labelId });
}

// 服务端直打(printer 空=服务器组件默认打印机;copies 1-10)
export function printContainerLabel(storeId, labelId, printer = '', copies = 1) {
  return post('/admin/api/print-agent/print-container-label', { storeId, labelId, printer, copies });
}

// 批量查询货运标签是否已打印 → { printed: { '123': true } }
export function getContainerLabelPrintStatus(storeId, labelIds) {
  const ids = (Array.isArray(labelIds) ? labelIds : []).join(',');
  return get('/admin/api/print-agent/container-label-print-status', { storeId, labelIds: ids });
}