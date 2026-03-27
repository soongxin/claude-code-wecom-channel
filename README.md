# WeCom Channel — Claude Code 企业微信智能机器人接入

将 Claude Code 接入企业微信智能机器人，直接在企微中与 Claude 对话，Claude 收到消息后处理并流式回复。

## 亮点

- **随时随地掌控 Claude** — 无需盯着终端，用企业微信就能给 Claude 下指令、查看进度，手机也能用
- **流式回复，实时感受思考过程** — 回复逐字推送，不用等 Claude 想完再发，长任务也不焦虑
- **图文皆可输入** — 直接发截图给 Claude，自动解密下载并识别，指哪打哪
- **通知 Hook，任务完成主动提醒** — Claude 进入等待时自动推送企微消息，不用一直切回来看
- **权限审批卡片** — Claude 执行敏感操作前推送交互卡片，一键允许或拒绝，手机也能审批
- **零侵入接入** — 纯 MCP Server 实现，不改 Claude Code 本身，升级 Claude 不受影响

---

## 前置条件

- macOS / Linux，已安装 Claude Code CLI
- Node.js 18+
- 在企业微信管理后台创建「智能机器人」，获取：
  - `WECOM_BOT_ID` — 机器人 ID
  - `WECOM_SECRET` — 机器人密钥

---

## 安装

将本仓库克隆到推荐路径：

```bash
git clone https://github.com/soongxin/claude-code-wecom-channel.git ~/.claude/claude-code-wecom-channel
cd ~/.claude/claude-code-wecom-channel
npm install
```

目录结构：

```
~/.claude/claude-code-wecom-channel/
├── channel.mjs      # 主程序
└── package.json     # 依赖声明
```

依赖项：
- `@modelcontextprotocol/sdk` — MCP 通信
- `@wecom/aibot-node-sdk` — 企业微信 WebSocket 连接

---

## 配置 MCP Server

编辑 `~/.claude.json`，在 `mcpServers` 下添加：

```json
{
  "mcpServers": {
    "wecom": {
      "command": "node",
      "args": ["/Users/你的用户名/.claude/claude-code-wecom-channel/channel.mjs"],
      "env": {
        "WECOM_BOT_ID": "你的机器人ID",
        "WECOM_SECRET": "你的机器人密钥",
        "WECOM_ENCODING_AES_KEY": "你的消息加解密Key"
      }
    }
  }
}
```

三个必填参数均可在企业微信管理后台「智能机器人 → 消息推送配置」中获取。其中 `WECOM_ENCODING_AES_KEY` 是图片消息和图文混排消息的解密密钥，不配置时图片将无法正常下载解析。

> `~/.claude.json` 是全局配置，对所有项目生效。

---

## 可选环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `BRIDGE_PORT` | `19088` | 本地 HTTP 服务端口（供 hook 调用） |
| `STREAM_CHUNK` | `15` | 流式回复每块字符数 |
| `STREAM_DELAY` | `200` | 流式回复块间隔（ms） |

> 注意：`WECOM_BOT_ID`、`WECOM_SECRET`、`WECOM_ENCODING_AES_KEY` 为必填项，在 MCP Server 的 `env` 中配置。

---

## 配置 Hooks（可选但推荐）

在项目或全局 `settings.json` 的 `hooks` 里添加以下配置，让 Claude Code 的系统通知推送到企微。

### 等待输入通知

Claude Code 进入等待状态时，发送文本通知卡片：

```json
{
  "hooks": {
    "Notification": [
      {
        "matcher": "idle_prompt|auth_success|elicitation_dialog",
        "hooks": [
          {
            "type": "command",
            "command": "python3 -c \"\nimport json, sys, urllib.request\ntry:\n    data = json.loads(sys.stdin.read())\n    msg = data.get('message') or data.get('title') or json.dumps(data, ensure_ascii=False)\n    req = urllib.request.Request('http://127.0.0.1:19088/notify', json.dumps({'text': msg, 'userid': '你的userid'}).encode(), {'Content-Type': 'application/json'})\n    urllib.request.urlopen(req, timeout=5)\nexcept: pass\n\" 2>/dev/null || true",
            "async": true
          }
        ]
      }
    ]
  }
}
```

### 权限请求审批

Claude Code 执行敏感操作时，推送交互卡片到企微，点击按钮决策：

```json
{
  "hooks": {
    "PermissionRequest": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "python3 ~/.claude/hooks/wecom-permission.py",
            "timeout": 360
          }
        ]
      }
    ]
  }
}
```

---

## 使用方式

1. 启动 Claude Code（`claude` 命令），MCP server 自动启动并连接企业微信
2. 在企业微信中找到你的智能机器人，直接发消息
3. Claude 收到消息后处理，自动流式回复

支持的消息类型：
- 文本
- 图片（自动下载解密后传给 Claude）
- 图文混合

---

## HTTP 接口说明

MCP server 启动后，本地监听 `http://127.0.0.1:19088`，提供以下接口供 hook 脚本调用：

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/status` | 查询连接状态 |
| POST | `/notify` | 发送文本通知卡片（无按钮） |
| POST | `/send-card` | 发送交互卡片（带允许/拒绝按钮） |
| POST | `/send` | 流式发送文本消息 |

### `/notify` 请求体

```json
{
  "userid": "用户ID",
  "title": "卡片标题",
  "text": "通知内容"
}
```

### `/send-card` 请求体

```json
{
  "userid": "用户ID",
  "title": "卡片标题",
  "subtitle": "副标题",
  "content_list": [
    { "keyname": "文件", "value": "/path/to/file" }
  ],
  "buttons": [
    { "text": "允许", "style": 1, "key": "allow" },
    { "text": "拒绝", "style": 2, "key": "deny" }
  ]
}
```

### 验证连接状态

```bash
curl http://127.0.0.1:19088/status
```

返回示例：

```json
{
  "ok": true,
  "connected": true,
  "lastUserId": "yourUserId",
  "recentUsers": ["yourUserId"]
}
```

---

## 常见问题

**Q: 启动后企微没有反应？**
检查 BOT_ID 和 SECRET 是否正确，确认机器人在企业微信后台已启用 WebSocket 模式。

**Q: 可以多人共用一个机器人吗？**
可以。同一个机器人可以接受多个用户消息，channel 会按 `userid` 区分并回复给对应用户。

**Q: 凭据可以共用吗？**
`WECOM_BOT_ID` 和 `WECOM_SECRET` 是企业维度的，同企业内可共用同一个机器人。跨企业需各自申请。

**Q: 启动时报 "Invalid permission rule" 错误？**
项目 `.claude/settings.json` 的 `permissions.allow` 里有括号不匹配的规则。通常是会话中自动写入的过长命令被截断导致的，手动删除这些无效规则即可。
