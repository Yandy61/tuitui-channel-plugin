# tuitui-multibot — 一份 channel 代码，多机器人多开

单进程直连版推推 × Claude Code 接入方案，做了多实例改造：**channel 代码只保留一份**，每个机器人一个独立配置 + 独立状态目录，互不影响。

## 目录结构

```
multibot/
├── tuitui-channel/          ← 唯一一份 channel 代码（server/ + node_modules/）
│   └── server/
│       ├── boot.mjs         ← MCP 入口（日志 + 异常兜底，再加载 index.mjs）
│       ├── index.mjs        ← 主逻辑：WS 收消息 / MCP 工具 / 权限审批转发
│       ├── state.mjs        ← 收件箱、去重、白名单、配对（读写 TUITUI_STATE_DIR）
│       └── tuitui-api.mjs   ← 推推开放平台 API（WS 长连接、发消息、表情）
├── bots/
│   └── bot2/                ← 每个机器人一个目录
│       ├── .mcp.json        ← 该机器人的 appid/secret + 独立 STATE_DIR（600 权限）
│       └── .state/          ← 该机器人的收件箱/白名单/游标（自动创建）
└── bin/
    ├── tui-new              ← 一键新开机器人会话（见下）
    ├── tui-status           ← 查看所有机器人收发状态
    └── tui-rotate           ← 清理超限日志（raw-events.jsonl 只增不减）
```

## 快速开始：新开一个机器人

```bash
/data2/liuyao3/ccbot/multibot/bin/tui-new <bot名称> <APP_ID> <APP_SECRET>
```

- 首次调用：自动生成 `bots/<bot名称>/.mcp.json`，创建独立 `.state/`，然后启动 claude 会话接入该机器人
- 再次调用同一 bot 名称：复用已有配置和状态（相当于恢复会话）
- 额外的 claude 参数直接追加，如 `tui-new bot3 <id> <secret> --model opus`
- 不带参数执行 `tui-new` 会打印用法

启动后在推推里给对应机器人发消息即可；DM 白名单默认 allowlist，首次需在 claude 会话里执行 `tuitui_access` 工具的 `allow` 动作放行你的账号（或直接编辑 `bots/<bot>/.state/access.json`）。

## 等价的手动命令

`tui-new` 本质等价于：

```bash
claude --mcp-config /data2/liuyao3/ccbot/multibot/bots/<bot>/.mcp.json \
       --dangerously-load-development-channels server:tuitui
```

## 日常运维

```bash
tui-status                 # 所有机器人：appid / DM策略 / 收件数 / 未读 / 最后消息时间
tui-rotate [上限MB=100]    # 清空超过上限的 raw-events.jsonl / notify-trace.log / boot.log
```

建议放进 crontab 每天跑一次 `tui-rotate`，防止日志无限增长（此前单实例 3 个月涨到 846MB）。

## 工作原理（单实例）

```
推推开放平台 ⇄ WebSocket(server/index.mjs 内建)
                    │ 收到消息 → 去重 → 白名单校验
                    ├─ 通过 → 存入 .state/inbox.jsonl
                    │        → notifications/claude/channel 注入当前 claude 会话
                    │        → claude 回合内调 tuitui_reply 回复（支持 tuitui_send_media / tuitui_react）
                    └─ 不通过 → 配对码 / 提示放行
claude 工具审批 → notifications/claude/channel/permission_request → 转发到推推
                  用户回复 "yes <code>" 放行，"yes-dont-ask-again <code>" 并写入项目设置
```

- 每个机器人实例 = 一个 claude 会话 + 一个独立 WS 连接，生命周期与会话绑定，会话退出即断线
- 多开数量只受推推开放平台对单 appid 长连接数限制约束（不同 appid 之间无限制）

## 环境要求

- Node.js ≥ 22（仓库为 ESM）
- Claude Code ≥ 2.1.224（`--dangerously-load-development-channels` 参数）
- 推推开放平台机器人的 appid + secret

## 首次克隆后必做

`node_modules/` 不入库（.gitignore 排除），克隆后必须先装依赖，否则 tui-new 启动的 MCP server 缺 `@modelcontextprotocol/sdk`、`ws`、`zod` 直接起不来（表现为收不到机器人消息，bot 目录 `.state/boot.log` 里有报错）：

```bash
cd tuitui-channel && npm install && cd ..
```

## 排查收不到消息

按顺序看 `bots/<bot名>/.state/` 下的日志：

1. `boot.log` — server 是否启动、依赖是否加载成功（缺依赖会在这里报 Cannot find module）
2. WS 是否连上（boot.log 有 "websocket connected"）；401 说明 appid/secret 不对
3. `notify-trace.log` — 消息是否到达、被白名单拦截（reason=dm_allowlist / pairing_required）
4. 白名单默认 allowlist：首次用 `tui_access` 工具 `allow` 你的账号，或编辑 `.state/access.json` 的 `allowFrom`
5. `tui-status` 一眼看收件数/未读/最后消息时间
