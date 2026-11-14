// lib/xf/auth.js — 讯飞 WebSocket 接口的 HMAC-SHA256 鉴权

import { createHmac } from 'node:crypto'

export function signWsUrl(url, { apiKey, apiSecret }, date = new Date().toUTCString()) {
  const u = new URL(url)
  const signature = createHmac('sha256', apiSecret)
    .update(`host: ${u.host}\ndate: ${date}\nGET ${u.pathname} HTTP/1.1`, 'utf8')
    .digest('base64')
  const origin = `api_key="${apiKey}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`
  const query = new URLSearchParams({
    authorization: Buffer.from(origin).toString('base64'),
    date,
    host: u.host,
  })
  return `${url}?${query}`
}
