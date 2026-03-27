#!/usr/bin/env node
/**
 * WeCom Channel MCP Server
 *
 * 双向通信：
 *   WeCom 消息 → MCP channel event → Claude Code session
 *   Claude Code reply tool → replyStream → WeCom
 *   Claude Code Notification hook → POST :19088/send-card → WeCom 模板卡片
 *
 * 环境变量：
 *   WECOM_BOT_ID   - 智能机器人 ID（必填）
 *   WECOM_SECRET   - 机器人密钥（必填）
 *   BRIDGE_PORT    - 本地 HTTP 端口（默认 19088）
 *   STREAM_CHUNK   - 流式输出每块字符数（默认 15）
 *   STREAM_DELAY   - 流式输出每块间隔 ms（默认 200）
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import AiBot, { generateReqId } from '@wecom/aibot-node-sdk'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const BOT_ID = process.env.WECOM_BOT_ID
const SECRET = process.env.WECOM_SECRET
const ENCODING_AES_KEY = SECRET
const PORT = parseInt(process.env.BRIDGE_PORT || '19088', 10)
const STREAM_CHUNK = parseInt(process.env.STREAM_CHUNK || '15', 10)
const STREAM_DELAY = parseInt(process.env.STREAM_DELAY || '200', 10)
const DECISIONS_DIR = path.join(__dirname, '..', 'wecom-bridge', 'inbox')

if (!BOT_ID || !SECRET) {
  process.stderr.write('Error: WECOM_BOT_ID and WECOM_SECRET are required\n')
  process.exit(1)
}

// ── 图片下载并解密（使用消息体中的 image.aeskey）────────────────────────────
async function downloadAndDecryptImage(url, aeskey) {
  if (!aeskey) return null

  const { buffer } = await wsClient.downloadFile(url, aeskey)
  const tmpFile = path.join(os.tmpdir(), `wecom_img_${Date.now()}.jpg`)
  fs.writeFileSync(tmpFile, buffer)
  return tmpFile
}

fs.mkdirSync(DECISIONS_DIR, { recursive: true })

// ── State ────────────────────────────────────────────────────────────────────
const recentFrames = new Map() // userid -> { frame, chattype, lastTime }
let lastUserId = null
let wsClient = null
let isAuthenticated = false
const pendingCards = new Map() // task_id -> { text, userid, createdAt }

// ── MCP Server ───────────────────────────────────────────────────────────────
const mcp = new Server(
  { name: 'wecom', version: '1.0.0' },
  {
    capabilities: {
      experimental: { 'claude/channel': {} },
      tools: {},
    },
    instructions: [
      'WeCom 消息通过 <channel source="wecom" userid="..." chattype="..."> 到达。',
      '收到消息后，请用 reply 工具回复，userid 从 channel 标签中获取。',
      '回复要简洁自然，像日常聊天一样。',
      '如果消息是问题或任务，先回答再操作；如果是闲聊，友好简短地回应。',
    ].join(' '),
  }
)

// ── reply tool ───────────────────────────────────────────────────────────────
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: 'reply',
    description: '通过 WeCom 流式回复用户消息',
    inputSchema: {
      type: 'object',
      properties: {
        userid: {
          type: 'string',
          description: '要回复的用户 ID（从 channel 标签的 userid 属性获取）',
        },
        text: {
          type: 'string',
          description: '要发送的消息内容',
        },
      },
      required: ['userid', 'text'],
    },
  }],
}))

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== 'reply') {
    throw new Error(`unknown tool: ${req.params.name}`)
  }

  const { userid, text } = req.params.arguments

  if (!isAuthenticated || !wsClient) {
    return { content: [{ type: 'text', text: 'error: WeCom not connected' }] }
  }

  const entry = recentFrames.get(userid) ?? recentFrames.get(lastUserId)
  if (!entry) {
    return { content: [{ type: 'text', text: 'error: no active frame for this user' }] }
  }

  try {
    await streamReply(entry.frame, text)
    process.stderr.write(`[channel] -> replied to ${userid} (${text.length} chars)\n`)
    return { content: [{ type: 'text', text: 'sent' }] }
  } catch (err) {
    process.stderr.write(`[channel] reply error: ${err.message}\n`)
    return { content: [{ type: 'text', text: `error: ${err.message}` }] }
  }
})

// ── 流式发送 ─────────────────────────────────────────────────────────────────
async function streamReply(frame, text) {
  const streamId = generateReqId('stream')
  const chunks = []
  for (let i = 0; i < text.length; i += STREAM_CHUNK) {
    chunks.push(text.slice(i, i + STREAM_CHUNK))
  }
  if (chunks.length === 0) return
  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1
    const accumulated = chunks.slice(0, i + 1).join('')
    await wsClient.replyStream(frame, streamId, accumulated, isLast)
    if (!isLast) await sleep(STREAM_DELAY)
  }
}

// ── WeCom WebSocket ──────────────────────────────────────────────────────────
function startWecom() {
  wsClient = new AiBot.WSClient({
    botId: BOT_ID,
    secret: SECRET,
    logger: {
      debug: () => {},
      info: (msg) => process.stderr.write(`[wecom] ${msg}\n`),
      warn: (msg) => process.stderr.write(`[wecom] WARN: ${msg}\n`),
      error: (msg) => process.stderr.write(`[wecom] ERROR: ${msg}\n`),
    },
  })

  wsClient.connect()

  wsClient.on('authenticated', () => {
    isAuthenticated = true
    process.stderr.write('[wecom] authenticated, channel ready\n')
  })

  wsClient.on('disconnected', () => {
    isAuthenticated = false
    process.stderr.write('[wecom] disconnected, reconnecting...\n')
  })

  wsClient.on('message.text', async (frame) => {
    const content = frame.body.text?.content || ''
    const userid = frame.body.from?.userid || 'unknown'
    const chattype = frame.body.chattype || 'single'

    recentFrames.set(userid, { frame, chattype, lastTime: Date.now() })
    lastUserId = userid

    process.stderr.write(`[wecom] <- [${userid}/${chattype}] ${content.slice(0, 80)}\n`)

    await mcp.notification({
      method: 'notifications/claude/channel',
      params: { content, meta: { userid, chattype } },
    })
  })

  wsClient.on('message.image', async (frame) => {
    const userid = frame.body.from?.userid || 'unknown'
    const chattype = frame.body.chattype || 'single'
    const url = frame.body.image?.url || ''
    const aeskey = frame.body.image?.aeskey || ''

    recentFrames.set(userid, { frame, chattype, lastTime: Date.now() })
    lastUserId = userid
    process.stderr.write(`[wecom] <- [${userid}/${chattype}] [图片]\n`)

    let content
    try {
      const imgPath = url ? await downloadAndDecryptImage(url, aeskey) : null
      content = imgPath ? `[图片] ${imgPath}` : `[图片] ${url}`
      if (imgPath) process.stderr.write(`[wecom] image decrypted -> ${imgPath}\n`)
    } catch (err) {
      process.stderr.write(`[wecom] image decrypt error: ${err.message}\n`)
      content = `[图片] ${url}`
    }

    await mcp.notification({
      method: 'notifications/claude/channel',
      params: { content, meta: { userid, chattype } },
    })
  })

  wsClient.on('message.mixed', async (frame) => {
    const userid = frame.body.from?.userid || 'unknown'
    const chattype = frame.body.chattype || 'single'
    const items = frame.body.mixed?.msg_item || []

    recentFrames.set(userid, { frame, chattype, lastTime: Date.now() })
    lastUserId = userid

    const parts = await Promise.all(items.map(async item => {
      if (item.msgtype === 'text') return item.text?.content || ''
      if (item.msgtype === 'image') {
        const url = item.image?.url || ''
        const aeskey = item.image?.aeskey || ''
        try {
          const imgPath = url ? await downloadAndDecryptImage(url, aeskey) : null
          if (imgPath) {
            process.stderr.write(`[wecom] mixed image decrypted -> ${imgPath}\n`)
            return `[图片] ${imgPath}`
          }
        } catch (err) {
          process.stderr.write(`[wecom] mixed image decrypt error: ${err.message}\n`)
        }
        return `[图片] ${url}`
      }
      return `[${item.msgtype}]`
    }))
    const content = parts.filter(Boolean).join('\n')

    process.stderr.write(`[wecom] <- [${userid}/${chattype}] [mixed] ${content.slice(0, 80)}\n`)

    await mcp.notification({
      method: 'notifications/claude/channel',
      params: { content, meta: { userid, chattype } },
    })
  })

  wsClient.on('event.template_card_event', async (frame) => {
    try {
      const cardEvent = frame.body.event?.template_card_event || {}
      const taskId = cardEvent.task_id
      const buttonKey = cardEvent.event_key || ''
      const userid = frame.body.from?.userid || 'unknown'

      process.stderr.write(`[wecom] card click: task=${taskId} key=${buttonKey}\n`)

      const card = pendingCards.get(taskId)
      const isDeny = buttonKey === 'deny'
      const label = isDeny ? '已拒绝' : '已允许'

      const updatedCard = {
        card_type: 'button_interaction',
        main_title: {
          title: label,
          desc: card?.subtitle || card?.text?.slice(0, 100) || '操作已响应',
        },
        button_list: [{ text: label, style: isDeny ? 2 : 1, key: buttonKey }],
        task_id: taskId,
      }
      if (card?.contentList?.length > 0) updatedCard.horizontal_content_list = card.contentList
      await wsClient.updateTemplateCard(frame, updatedCard)

      const decision = {
        timestamp: new Date().toISOString(),
        task_id: taskId,
        decision: buttonKey,
        userid,
        text: card?.text || '',
      }
      fs.appendFileSync(path.join(DECISIONS_DIR, 'decisions.jsonl'), JSON.stringify(decision) + '\n')
      fs.writeFileSync(path.join(DECISIONS_DIR, 'latest_decision.json'), JSON.stringify(decision, null, 2))

      if (card) pendingCards.delete(taskId)
    } catch (e) {
      process.stderr.write(`[wecom] card event error: ${e.message}\n`)
    }
  })

  wsClient.on('event.enter_chat', async (frame) => {
    try {
      await wsClient.replyWelcome(frame, {
        msgtype: 'text',
        text: { content: 'Claude 已连接，发消息即可开始对话' },
      })
    } catch (e) {
      process.stderr.write(`[wecom] welcome error: ${e.message}\n`)
    }
  })
}

// ── HTTP 服务（供 Notification hook 调用）────────────────────────────────────
function startHttpServer() {
  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

    if (req.method === 'OPTIONS') {
      res.writeHead(204); res.end(); return
    }

    if (req.method === 'GET' && req.url === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        ok: true,
        connected: isAuthenticated,
        lastUserId,
        recentUsers: Array.from(recentFrames.keys()),
      }))
      return
    }

    if (req.method === 'POST' && req.url === '/notify') {
      let body = ''
      req.on('data', chunk => body += chunk)
      req.on('end', async () => {
        try {
          const data = JSON.parse(body)
          const title = data.title || '🔔 Claude Code'
          const text = data.text || data.content || data.subtitle || ''
          const userid = data.userid || data.chatid || lastUserId

          if (!userid) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: 'missing userid' }))
            return
          }

          if (!isAuthenticated || !wsClient) {
            res.writeHead(503, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: 'WeCom not connected' }))
            return
          }

          await wsClient.sendMessage(userid, {
            msgtype: 'template_card',
            template_card: {
              card_type: 'text_notice',
              main_title: { title, desc: text.slice(0, 256) },
              card_action: { type: 1, url: 'https://work.weixin.qq.com' },
            },
          })
          process.stderr.write(`[http] notify sent to ${userid}: ${text.slice(0, 60)}\n`)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true }))
        } catch (err) {
          const msg = err?.message || err?.errMsg || String(err)
          process.stderr.write(`[http] notify error: ${msg}\n`)
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: msg }))
        }
      })
      return
    }

    if (req.method === 'POST' && (req.url === '/send-card' || req.url === '/send')) {
      let body = ''
      req.on('data', chunk => body += chunk)
      req.on('end', async () => {
        try {
          const data = JSON.parse(body)
          const text = data.text || data.content || data.subtitle || data.title || ''
          const userid = data.userid || data.chatid || lastUserId

          if (!text && req.url === '/send') {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: 'missing text' }))
            return
          }

          if (!isAuthenticated || !wsClient) {
            res.writeHead(503, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: 'WeCom not connected' }))
            return
          }

          if (req.url === '/send-card') {
            if (!userid) {
              res.writeHead(400, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ ok: false, error: 'missing userid' }))
              return
            }
            const taskId = generateReqId('card')
            const cardTitle = data.title || '🔔 Claude Code 需要确认'
            const cardSubtitle = data.subtitle || text.slice(0, 128)
            const contentList = data.content_list || []
            const buttons = data.buttons || [
              { text: '✅ 允许', style: 1, key: 'allow' },
              { text: '❌ 拒绝', style: 2, key: 'deny' },
            ]
            pendingCards.set(taskId, { title: cardTitle, subtitle: cardSubtitle, contentList, userid, createdAt: Date.now() })
            const templateCard = {
              card_type: 'button_interaction',
              main_title: { title: cardTitle, desc: cardSubtitle },
              button_list: buttons,
              task_id: taskId,
            }
            if (contentList.length > 0) templateCard.horizontal_content_list = contentList
            await wsClient.sendMessage(userid, { msgtype: 'template_card', template_card: templateCard })
            process.stderr.write(`[http] card sent task=${taskId} to ${userid}\n`)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: true, task_id: taskId }))
          } else {
            // /send - 流式回复或主动推送
            const entry = userid ? recentFrames.get(userid) : null
            if (entry) {
              await streamReply(entry.frame, text)
            } else if (userid) {
              await wsClient.sendMessage(userid, {
                msgtype: 'markdown',
                markdown: { content: text.slice(0, 4000) },
              })
            } else {
              res.writeHead(400, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ ok: false, error: 'no userid or active frame' }))
              return
            }
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: true }))
          }
        } catch (err) {
          process.stderr.write(`[http] error: ${err.message}\n`)
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: err.message }))
        }
      })
      return
    }

    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  })

  server.listen(PORT, '127.0.0.1', () => {
    process.stderr.write(`[http] listening on http://127.0.0.1:${PORT}\n`)
  })
}

// ── 清理过期记录 ──────────────────────────────────────────────────────────────
setInterval(() => {
  const cutoff = Date.now() - 3600_000
  for (const [k, v] of recentFrames) {
    if (v.lastTime < cutoff) recentFrames.delete(k)
  }
  for (const [k, v] of pendingCards) {
    if (v.createdAt < cutoff) pendingCards.delete(k)
  }
}, 600_000)

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

// ── Main ─────────────────────────────────────────────────────────────────────
process.stderr.write('=== WeCom Channel MCP Server ===\n')
process.stderr.write(`STREAM_CHUNK=${STREAM_CHUNK} chars  STREAM_DELAY=${STREAM_DELAY}ms\n`)

startWecom()
startHttpServer()
await mcp.connect(new StdioServerTransport())
