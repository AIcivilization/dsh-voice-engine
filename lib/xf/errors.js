// lib/xf/errors.js — 把讯飞的报错翻译成下一步该做什么
//
// 这些都是真实踩过的：服务没开、没有字符量、音色没授权，返回的都是 11200；
// 握手失败时 WebSocket 拿不到原因，要另外发请求读服务器的文字。

import { looksSwapped } from '../config.js'

export const SERVICE_PAGE = {
  hyper: 'https://console.xfyun.cn/services/uts',
  v2: 'https://console.xfyun.cn/services/tts',
}
export const HYPER_QUOTA_PAGE = 'https://console.xfyun.cn/sale/buy?wareId=9134&packageId=9134001&serviceName=%E8%B6%85%E6%8B%9F%E4%BA%BA%E5%90%88%E6%88%90&businessId=uts'

/** 握手阶段的报错：服务器返回的文字 → 用户该做什么 */
export function explainHandshake({ status, message }, creds) {
  const text = String(message ?? '')
  if (status === 0) {
    return { kind: 'network', summary: '连不上讯飞服务器', hint: `检查网络或代理设置（${text || '无详细信息'}）` }
  }
  if (/apikey not found/i.test(text)) {
    return {
      kind: 'credentials',
      summary: 'APIKey 不对',
      hint: looksSwapped(creds)
        ? 'APIKey 和 APISecret 很可能填反了：控制台上 APISecret 排在前面。请在设置里重新填写'
        : '请到控制台语音服务页复制 APIKey，确认和 AppID 属于同一个应用',
    }
  }
  if (/signature does not match/i.test(text)) {
    return { kind: 'credentials', summary: 'APISecret 不对', hint: '请到控制台语音服务页复制 APISecret，确认和 APIKey 属于同一个应用' }
  }
  if (/date/i.test(text)) {
    return { kind: 'clock', summary: '电脑时间不准', hint: '讯飞要求和服务器时间相差不超过 5 分钟，请校准系统时间' }
  }
  return { kind: 'unknown', summary: `握手失败（HTTP ${status}）`, hint: text || '请运行 /voice-doctor 查看详情' }
}

/**
 * 合成阶段的错误码。allFailed 表示这个引擎的所有音色都用不了：
 * 这时问题在服务或字符量，而不是某个音色。
 */
export function explainCode(code, { engine = 'hyper', vcn, allFailed = false } = {}) {
  const page = SERVICE_PAGE[engine] ?? SERVICE_PAGE.hyper
  switch (Number(code)) {
    case 11200:
      if (allFailed) {
        return {
          kind: 'service',
          summary: engine === 'hyper' ? '超拟人合成还不能用' : '在线语音合成还不能用',
          hint: engine === 'hyper'
            ? `服务没开通或没有字符量。先领取字符量：${HYPER_QUOTA_PAGE} ，再到 ${page} 确认选的是同一个应用`
            : `服务没开通或没有额度，请到 ${page} 确认选的是同一个应用`,
        }
      }
      return {
        kind: 'voice',
        summary: `音色 ${vcn ?? ''} 未授权`.trim(),
        hint: `这个音色没有授权给当前应用。可以换已授权的音色，或到 ${page} 添加发音人。音色授权和字符量是两项独立的权限`,
      }
    case 11201:
      return { kind: 'quota', summary: '今天的调用次数用完了', hint: `明天再试，或到 ${page} 提升额度` }
    case 11202:
    case 11203:
      return { kind: 'rate', summary: '请求太快，超过了并发或秒级限制', hint: '稍等几秒再试，批量任务要降低并发' }
    case 10163:
      return { kind: 'param', summary: '参数不被接受', hint: '多半是音色编码不存在。用 voice_voices 查可用的编码' }
    case 10313:
      return { kind: 'credentials', summary: 'AppID 和 APIKey 对不上', hint: '三项凭据要从同一个应用复制' }
    default:
      return { kind: 'unknown', summary: `讯飞错误 ${code}`, hint: '可以运行 /voice-doctor 检查，或对照官方错误码文档' }
  }
}
