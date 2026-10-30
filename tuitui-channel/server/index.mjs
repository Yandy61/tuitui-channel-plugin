import { homedir } from "node:os";
import { join } from "node:path";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod";
import {
  CHAT_TYPE_DIRECT,
  CHAT_TYPE_GROUP,
  CHAT_TYPE_CHANNEL,
  createWebSocketClient,
  buildMessageBody,
  sendTextMsg,
  sendMediaMsg,
  emojiReaction,
  guessChatType,
  teamsBuildChatId,
} from "./tuitui-api.mjs";
import { StateStore } from "./state.mjs";

const stateDir =
  process.env.TUITUI_STATE_DIR ||
  join(homedir(), ".claude", "channels", "tuitui");
const bootLogFile = join(stateDir, "boot.log");
const notifyTraceFile = join(stateDir, "notify-trace.log");
const projectSettingsDir = join(process.cwd(), ".claude");
const projectSettingsLocalFile = join(
  projectSettingsDir,
  "settings.local.json",
);
const execFileAsync = promisify(execFile);
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
const AUTO_REPLY_ENABLED =
  String(process.env.TUITUI_AUTO_REPLY || "true").toLowerCase() !== "false";
const account = {
  appId: process.env.TUITUI_APP_ID,
  appSecret: process.env.TUITUI_APP_SECRET,
  dmPolicy: process.env.TUITUI_DM_POLICY || "pairing",
  groupPolicy: process.env.TUITUI_GROUP_POLICY || "allowlist",
  requireMention:
    String(process.env.TUITUI_REQUIRE_MENTION || "true").toLowerCase() !==
    "false",
  channelContext: process.env.TUITUI_CHANNEL_CONTEXT || "thread",
};
mkdirSync(stateDir, { recursive: true });

function logBoot(line) {
  try {
    appendFileSync(bootLogFile, `${new Date().toISOString()} ${line}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "a",
    });
  } catch {}
}

logBoot(`[BOOT] tuitui-channel index.mjs start pid=${process.pid}`);
logBoot("[BOOT] marker=2026-03-23-v2-runtime-probe");
logBoot(
  `[BOOT] env TUITUI_DM_POLICY=${process.env.TUITUI_DM_POLICY || ""} TUITUI_STATE_DIR=${process.env.TUITUI_STATE_DIR || ""}`,
);

process.on("uncaughtException", (err) => {
  logBoot(`[BOOT] uncaughtException ${err?.stack || err}`);
});
process.on("unhandledRejection", (err) => {
  logBoot(`[BOOT] unhandledRejection ${err?.stack || err}`);
});

const store = new StateStore(stateDir);
const server = new McpServer(
  {
    name: "tuitui-channel",
    version: "0.1.0",
  },
  {
    capabilities: {
      experimental: {
        "claude/channel": {},
        "claude/channel/permission": {},
      },
      tools: {},
    },
    instructions: [
      "Messages from TuiTui users arrive through notifications/claude/channel.",
      "Reply with the tuitui_reply tool.",
      "Use sender_id / chat_id from meta when deciding where to reply.",
      "Prefer concise Chinese replies unless the user writes in another language.",
      "Avoid markdown tables; TuiTui is a chat surface.",
    ].join("\n"),
  },
);
let ws = null;
const recentMessageIds = new Set();
const pendingPermissionRequests = new Map();
const PERSIST_PERMISSION_REPLY_RE =
  /^\s*(?:yes-dont-ask-again|y-dont-ask-again)\s+([a-km-z]{5})\s*$/i;
const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i;

function normalizePermissionReplyText(envelope) {
  const text = String(envelope?.text || "").trim();
  if (!text) return text;

  const commandMatch = text.match(
    /(?:^|\s)(yes-dont-ask-again|y-dont-ask-again|yes|y|no|n)\s+([a-km-z]{5})(?=\s|$)/i,
  );
  if (!commandMatch) return text;

  if (!envelope?.atMe && commandMatch.index !== 0) return text;

  return `${commandMatch[1]} ${commandMatch[2]}`;
}

function readJsonFile(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeProjectPermissionAllow(toolName) {
  mkdirSync(projectSettingsDir, { recursive: true });
  const current = existsSync(projectSettingsLocalFile)
    ? readJsonFile(projectSettingsLocalFile, {})
    : {};
  const next =
    current && typeof current === "object" && !Array.isArray(current)
      ? { ...current }
      : {};
  const permissions =
    next.permissions &&
    typeof next.permissions === "object" &&
    !Array.isArray(next.permissions)
      ? { ...next.permissions }
      : {};
  const allow = Array.isArray(permissions.allow) ? [...permissions.allow] : [];
  const added = !allow.includes(toolName);
  if (added) allow.push(toolName);
  permissions.allow = allow;
  next.permissions = permissions;
  writeFileSync(
    projectSettingsLocalFile,
    `${JSON.stringify(next, null, 2)}\n`,
    {
      encoding: "utf8",
      mode: 0o600,
    },
  );
  return {
    added,
    settingsPath: projectSettingsLocalFile,
    allow,
  };
}

function rememberLastDeliveredChat(envelope) {
  const meta = store.loadMeta();
  meta.lastDeliveredChat = {
    chatId: envelope.chatId,
    chatType: envelope.chatType,
    senderId: envelope.senderId,
    senderName: envelope.senderName,
    groupName: envelope.groupName || null,
    updatedAt: Date.now(),
  };
  store.saveMeta(meta);
}

function buildPermissionRelayText(params) {
  const lines = [
    "Claude 请求工具审批",
    `工具: ${params.tool_name}`,
    `说明: ${params.description}`,
  ];
  if (params.input_preview) lines.push(`参数: ${params.input_preview}`);
  lines.push(
    `回复 yes ${params.request_id} 允许，或 no ${params.request_id} 拒绝`,
  );
  lines.push(
    `回复 yes-dont-ask-again ${params.request_id} 允许并写入本地项目设置`,
  );
  return lines.join("\n");
}

async function relayPermissionRequest(params) {
  pendingPermissionRequests.set(params.request_id, {
    toolName: params.tool_name,
    description: params.description,
    inputPreview: params.input_preview,
    relayedAt: Date.now(),
  });

  const meta = store.loadMeta();
  meta.lastPermissionRequestAt = Date.now();
  meta.lastPermissionRelay = {
    requestId: params.request_id,
    toolName: params.tool_name,
    description: params.description,
    inputPreview: params.input_preview,
    target: meta.lastDeliveredChat || null,
    relayedAt: Date.now(),
  };
  store.saveMeta(meta);

  traceNotify("permission_request:received", {
    requestId: params.request_id,
    toolName: params.tool_name,
  });

  const target = meta.lastDeliveredChat;
  if (!target?.chatId || !target?.chatType) {
    traceNotify("permission_request:skipped_no_target", {
      requestId: params.request_id,
    });
    console.error(
      `[tuitui-channel] permission relay skipped requestId=${params.request_id} reason=no_active_chat`,
    );
    return;
  }

  await sendTextMsg(
    account,
    target.chatId,
    target.chatType,
    buildPermissionRelayText(params),
  );

  traceNotify("permission_request:relayed", {
    requestId: params.request_id,
    chatId: target.chatId,
    chatType: target.chatType,
  });
  console.error(
    `[tuitui-channel] permission relay sent requestId=${params.request_id} chatId=${target.chatId}`,
  );
}

function normalizeId(v) {
  return String(v || "")
    .toLowerCase()
    .trim();
}

function traceNotify(msg, extra = undefined) {
  try {
    const line = `${new Date().toISOString()} ${msg}${extra !== undefined ? ` ${JSON.stringify(extra)}` : ""}\n`;
    appendFileSync(notifyTraceFile, line, {
      encoding: "utf8",
      mode: 0o600,
      flag: "a",
    });
  } catch {}
}

function buildInboundEnvelope(json) {
  const msg = json?.body || {};
  const data = msg.data || {};
  const event = msg.event;
  const senderId = normalizeId(msg.user_account || msg.uid);
  const senderName = msg.user_name || msg.user_account || msg.uid || "unknown";
  let chatType = CHAT_TYPE_DIRECT;
  let chatId = senderId;
  let groupName = undefined;
  let text = buildMessageBody(data);
  let messageId = data.msgid || data.post_id || `${Date.now()}`;
  if (event === "group_chat") {
    chatType = CHAT_TYPE_GROUP;
    chatId = normalizeId(data.group_id);
    groupName = data.group_name;
  } else if (event === "teams_post_create") {
    chatType = CHAT_TYPE_CHANNEL;
    const team_id = data.team_id;
    const channel_id = data.channel_id;
    const thread_id =
      data.parent_id && data.parent_id !== "0" ? data.parent_id : data.post_id;
    chatId = teamsBuildChatId(team_id, channel_id, thread_id);
    messageId = data.post_id;
    text = data.content || text;
    groupName = `team:${team_id}/channel:${channel_id}`;
  }
  return {
    event,
    senderId,
    senderName,
    userAccount: normalizeId(msg.user_account),
    uid: msg.uid,
    chatType,
    chatId,
    groupName,
    text,
    messageId,
    timestamp: msg.timestamp || new Date().toISOString(),
    atMe: !!data.at_me,
    raw: json,
  };
}

function isAllowed(envelope) {
  const access = store.loadAccess();
  if (envelope.chatType === CHAT_TYPE_DIRECT) {
    const policy = access.dmPolicy || account.dmPolicy;
    if (policy === "disabled") return { allowed: false, reason: "dm_disabled" };
    if (policy === "open") return { allowed: true };
    const allowed = new Set((access.allowFrom || []).map(normalizeId));
    if (allowed.has(normalizeId(envelope.senderId))) return { allowed: true };
    if (policy === "pairing")
      return { allowed: false, reason: "pairing_required" };
    return { allowed: false, reason: "dm_allowlist" };
  }
  const groupPolicy = access.groupPolicy || account.groupPolicy;
  if (groupPolicy === "disabled")
    return { allowed: false, reason: "group_disabled" };
  if (account.requireMention && !envelope.atMe) {
    return { allowed: false, reason: "mention_required" };
  }
  if (envelope.chatType === CHAT_TYPE_CHANNEL) {
    const teamAllow = new Set((access.teamAllowFrom || []).map(normalizeId));
    const teamId = normalizeId(envelope.raw?.body?.data?.team_id);
    if (teamAllow.has(teamId)) return { allowed: true };
    return { allowed: false, reason: "team_allowlist" };
  }
  const groupAllow = new Set((access.groupAllowFrom || []).map(normalizeId));
  if (groupAllow.has(normalizeId(envelope.chatId))) return { allowed: true };
  return { allowed: false, reason: "group_allowlist" };
}

async function maybeHandleUnauthorized(envelope, decision) {
  if (!account.appId || !account.appSecret) return;
  if (decision.reason === "pairing_required") {
    const code = store.createPairing(envelope.senderId, envelope.chatId);
    await sendTextMsg(
      account,
      envelope.chatId,
      envelope.chatType,
      `当前 Claude Code TuiTui 插件需要配对，请在 Claude Code 中执行配对工具并输入 code: ${code}`,
    );
  } else if (decision.reason === "dm_allowlist") {
    await sendTextMsg(
      account,
      envelope.chatId,
      envelope.chatType,
      `当前会话未放行。请在 Claude Code 中把白名单加入：${envelope.senderId}`,
    );
  } else if (decision.reason === "group_allowlist") {
    await sendTextMsg(
      account,
      envelope.chatId,
      envelope.chatType,
      `当前群聊未放行。请在 Claude Code 中把群白名单加入：${envelope.chatId}`,
    );
  } else if (decision.reason === "team_allowlist") {
    const teamId = envelope.raw?.body?.data?.team_id;
    await sendTextMsg(
      account,
      envelope.chatId,
      envelope.chatType,
      `当前团队未放行。请在 Claude Code 中把团队白名单加入：${teamId}`,
    );
  }
}

async function emitClaudeChannelNotification(envelope) {
  const rawMeta = {
    sender: envelope.senderName,
    sender_id: envelope.senderId,
    chat_id: envelope.chatId,
    chat_type: envelope.chatType,
    message_id: envelope.messageId,
    timestamp: envelope.timestamp,
    group_name: envelope.groupName,
    user_account: envelope.userAccount,
    uid: envelope.uid,
    event: envelope.event,
    reply_to_id: envelope.raw?.body?.data?.ref?.msgid,
    teams_post_id: envelope.raw?.body?.data?.post_id,
    teams_parent_id: envelope.raw?.body?.data?.parent_id,
    teams_team_id: envelope.raw?.body?.data?.team_id,
    teams_channel_id: envelope.raw?.body?.data?.channel_id,
    cursor: envelope.cursor,
  };
  const meta = Object.fromEntries(
    Object.entries(rawMeta)
      .filter(([, v]) => v !== undefined && v !== null && v !== "")
      .map(([k, v]) => [k, String(v)]),
  );
  const params = {
    content: String(envelope.text ?? ""),
    meta,
  };
  traceNotify("emitClaudeChannelNotification:before", {
    messageId: envelope.messageId,
    chatId: envelope.chatId,
    cursor: envelope.cursor,
    text: String(envelope.text || "").slice(0, 120),
  });
  try {
    await server.server.notification({
      method: "notifications/claude/channel",
      params,
    });
    rememberLastDeliveredChat(envelope);
    traceNotify("emitClaudeChannelNotification:after", {
      messageId: envelope.messageId,
      chatId: envelope.chatId,
      cursor: envelope.cursor,
    });
  } catch (err) {
    traceNotify("emitClaudeChannelNotification:error", {
      messageId: envelope.messageId,
      chatId: envelope.chatId,
      cursor: envelope.cursor,
      error: err?.message || String(err),
    });
    console.error(
      "[tuitui-channel] notifications/claude/channel failed:",
      err?.message || err,
    );
  }
}

async function emitPermissionDecision(envelope, requestId, behavior) {
  const meta = store.loadMeta();
  meta.lastPermissionDecisionAt = Date.now();
  meta.lastPermissionDecision = {
    requestId,
    behavior,
    senderId: envelope.senderId,
    chatId: envelope.chatId,
    chatType: envelope.chatType,
    decidedAt: Date.now(),
  };
  store.saveMeta(meta);

  traceNotify("permission_decision:before", {
    requestId,
    behavior,
    senderId: envelope.senderId,
    chatId: envelope.chatId,
  });

  await server.server.notification({
    method: "notifications/claude/channel/permission",
    params: {
      request_id: requestId,
      behavior,
    },
  });

  pendingPermissionRequests.delete(requestId);

  traceNotify("permission_decision:after", {
    requestId,
    behavior,
    senderId: envelope.senderId,
    chatId: envelope.chatId,
  });
  console.error(
    `[tuitui-channel] permission decision sent requestId=${requestId} behavior=${behavior} chatId=${envelope.chatId}`,
  );
}

async function persistPermissionAllow(envelope, requestId) {
  const pending = pendingPermissionRequests.get(requestId);
  if (!pending?.toolName) {
    traceNotify("permission_persist:missing_request", {
      requestId,
      senderId: envelope.senderId,
      chatId: envelope.chatId,
    });
    console.error(
      `[tuitui-channel] permission persist skipped requestId=${requestId} reason=missing_request`,
    );
    return false;
  }

  const persisted = writeProjectPermissionAllow(pending.toolName);
  const meta = store.loadMeta();
  meta.lastPermissionPersistAt = Date.now();
  meta.lastPermissionPersist = {
    requestId,
    toolName: pending.toolName,
    settingsPath: persisted.settingsPath,
    added: persisted.added,
    savedAt: Date.now(),
  };
  store.saveMeta(meta);

  traceNotify("permission_persist:after", {
    requestId,
    toolName: pending.toolName,
    settingsPath: persisted.settingsPath,
    added: persisted.added,
  });
  console.error(
    `[tuitui-channel] permission persist saved requestId=${requestId} tool=${pending.toolName} added=${persisted.added}`,
  );

  await emitPermissionDecision(envelope, requestId, "allow");
  return true;
}

async function handleInboundJson(json) {
  const envelope = buildInboundEnvelope(json);
  const eventId = json?.event_id || json?.header?.event_id || "";
  const dedupeKey = [
    eventId,
    envelope.chatId,
    envelope.messageId,
    envelope.timestamp,
    envelope.text,
  ].join("|");
  store.appendRawEvent({
    receivedAt: Date.now(),
    dedupeKey,
    eventId,
    envelope,
    raw: json,
  });
  if (!envelope.chatId || !envelope.messageId) {
    console.error("[tuitui-channel] inbound missing chatId/messageId");
    return;
  }
  if (recentMessageIds.has(dedupeKey) || store.hasSeen(dedupeKey)) {
    console.error(
      `[tuitui-channel] deduped inbound eventId=${eventId} messageId=${envelope.messageId}`,
    );
    return;
  }
  recentMessageIds.add(dedupeKey);
  store.rememberSeen(dedupeKey);
  if (recentMessageIds.size > 500) {
    const first = recentMessageIds.values().next().value;
    if (first) recentMessageIds.delete(first);
  }
  console.error(
    `[tuitui-channel] inbound accept eventId=${eventId} messageId=${envelope.messageId} text=${JSON.stringify(envelope.text).slice(0, 300)}`,
  );
  const decision = isAllowed(envelope);
  if (!decision.allowed) {
    console.error(
      `[tuitui-channel] inbound unauthorized reason=${decision.reason} eventId=${eventId} messageId=${envelope.messageId}`,
    );
    await maybeHandleUnauthorized(envelope, decision);
    return;
  }

  if (account.appId && account.appSecret && envelope.atMe) {
    try {
      await emojiReaction(
        account,
        envelope.chatId,
        envelope.chatType,
        envelope.messageId,
        "收到",
      );
    } catch {}
  }

  const permissionText = normalizePermissionReplyText(envelope);

  const persistPermissionMatch =
    PERSIST_PERMISSION_REPLY_RE.exec(permissionText);
  if (persistPermissionMatch) {
    const requestId = persistPermissionMatch[1].toLowerCase();
    await persistPermissionAllow(envelope, requestId);
    return;
  }

  const permissionMatch = PERMISSION_REPLY_RE.exec(permissionText);
  if (permissionMatch) {
    const requestId = permissionMatch[2].toLowerCase();
    const behavior = permissionMatch[1].toLowerCase().startsWith("y")
      ? "allow"
      : "deny";
    await emitPermissionDecision(envelope, requestId, behavior);
    return;
  }

  const cursor = store.appendInbox({ ...envelope, readAt: null, eventId });
  await emitClaudeChannelNotification({ ...envelope, cursor, eventId });
  console.error(
    `[tuitui-channel] delivered channel notification messageId=${envelope.messageId} cursor=${cursor}`,
  );
}

function ensureWs() {
  if (!account.appId || !account.appSecret) {
    console.error("[tuitui-channel] missing TUITUI_APP_ID / TUITUI_APP_SECRET");
    return;
  }
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
  ws = createWebSocketClient(account, {
    onOpen: () => {
      const meta = store.loadMeta();
      meta.lastWsConnectAt = Date.now();
      store.saveMeta(meta);
      console.error("[tuitui-channel] websocket connected");
    },
    onJson: handleInboundJson,
    onError: (err) =>
      console.error("[tuitui-channel] websocket error", err?.message || err),
    onClose: () => {
      console.error("[tuitui-channel] websocket closed, retry in 5s");
      setTimeout(ensureWs, 5000).unref?.();
    },
  });
}

server.registerTool(
  "tuitui_reply",
  {
    description: "Send a text message back to a TuiTui chat/channel/thread.",
    inputSchema: {
      chat_id: z
        .string()
        .optional()
        .describe(
          "Target chat id, group id, or teams_<team>_<channel>_<thread>",
        ),
      sender_id: z
        .string()
        .optional()
        .describe(
          "Direct-chat sender id from notifications/claude/channel meta",
        ),
      text: z.string().describe("Message text"),
      chat_type: z
        .enum([CHAT_TYPE_DIRECT, CHAT_TYPE_GROUP, CHAT_TYPE_CHANNEL])
        .optional()
        .describe("Optional explicit chat type"),
      reply_to_post_id: z
        .string()
        .optional()
        .describe(
          "Teams channel reply target post_id for direct in-thread replies",
        ),
    },
  },
  async ({ chat_id, sender_id, text, chat_type, reply_to_post_id }) => {
    const target = chat_id || sender_id;
    if (!target) throw new Error("chat_id or sender_id is required");
    await sendTextMsg(
      account,
      target,
      chat_type || guessChatType(target),
      text,
      { reply_to_post_id },
    );
    return { content: [{ type: "text", text: `Sent to ${target}` }] };
  },
);

server.registerTool(
  "tuitui_send_media",
  {
    description: "Send an image/file to a TuiTui conversation.",
    inputSchema: {
      chat_id: z.string(),
      media_url: z.string().describe("http(s), local path, or data: URL"),
      chat_type: z
        .enum([CHAT_TYPE_DIRECT, CHAT_TYPE_GROUP, CHAT_TYPE_CHANNEL])
        .optional(),
    },
  },
  async ({ chat_id, media_url, chat_type }) => {
    await sendMediaMsg(
      account,
      chat_id,
      chat_type || guessChatType(chat_id),
      media_url,
    );
    return { content: [{ type: "text", text: `Media sent to ${chat_id}` }] };
  },
);

server.registerTool(
  "tuitui_react",
  {
    description: "Add a TuiTui emoji reaction to a specific message.",
    inputSchema: {
      chat_id: z.string(),
      message_id: z.string(),
      emoji: z.string().default("收到"),
      chat_type: z
        .enum([CHAT_TYPE_DIRECT, CHAT_TYPE_GROUP, CHAT_TYPE_CHANNEL])
        .optional(),
    },
  },
  async ({ chat_id, message_id, emoji, chat_type }) => {
    await emojiReaction(
      account,
      chat_id,
      chat_type || guessChatType(chat_id),
      message_id,
      emoji,
    );
    return {
      content: [{ type: "text", text: `Reacted ${emoji} to ${message_id}` }],
    };
  },
);

server.registerTool(
  "tuitui_check_new",
  {
    description: "Quickly check whether new TuiTui messages have arrived.",
    inputSchema: { after_cursor: z.number().optional().default(0) },
  },
  async ({ after_cursor }) => {
    const rows = store.listMessages(20, true, after_cursor);
    return {
      content: [
        {
          type: "text",
          text: rows.length
            ? `There are ${rows.length} unread messages.`
            : "No unread messages.",
        },
      ],
      structuredContent: { unread: rows.length, messages: rows },
    };
  },
);

server.registerTool(
  "tuitui_get_messages",
  {
    description:
      "Fetch recent TuiTui inbox messages stored by the local bridge.",
    inputSchema: {
      limit: z.number().min(1).max(100).default(20),
      unread_only: z.boolean().default(false),
      after_cursor: z.number().optional().default(0),
      mark_read: z.boolean().default(false),
    },
  },
  async ({ limit, unread_only, after_cursor, mark_read }) => {
    const rows = store.listMessages(limit, unread_only, after_cursor);
    if (mark_read && rows.length) {
      const maxCursor = Math.max(...rows.map((x) => Number(x.cursor || 0)));
      store.markRead(maxCursor);
    }
    return {
      content: [
        {
          type: "text",
          text:
            rows
              .map((m) => `[#${m.cursor}] ${m.senderName}: ${m.text}`)
              .join("\n\n") || "No messages.",
        },
      ],
      structuredContent: { messages: rows },
    };
  },
);

server.registerTool(
  "tuitui_access",
  {
    description:
      "Manage local pairing / allowlist state for the TuiTui Claude Code channel.",
    inputSchema: {
      action: z.enum([
        "status",
        "pair",
        "allow",
        "remove",
        "policy",
        "group-allow",
        "team-allow",
      ]),
      code: z.string().optional(),
      sender_id: z.string().optional(),
      value: z.string().optional(),
    },
  },
  async ({ action, code, sender_id, value }) => {
    const access = store.loadAccess();
    let text = "";
    if (action === "status") {
      text = JSON.stringify(
        {
          dmPolicy: access.dmPolicy,
          allowFrom: access.allowFrom || [],
          groupPolicy: access.groupPolicy,
          groupAllowFrom: access.groupAllowFrom || [],
          teamAllowFrom: access.teamAllowFrom || [],
          pending: access.pending || {},
        },
        null,
        2,
      );
    } else if (action === "pair") {
      if (!code) throw new Error("code is required");
      const approved = store.approvePairing(code);
      if (!approved) throw new Error(`pairing code not found: ${code}`);
      text = `paired ${approved.senderId}`;
    } else if (action === "allow") {
      if (!sender_id) throw new Error("sender_id is required");
      access.allowFrom = Array.from(
        new Set([...(access.allowFrom || []), normalizeId(sender_id)]),
      );
      store.saveAccess(access);
      text = `allowed ${sender_id}`;
    } else if (action === "remove") {
      if (!sender_id) throw new Error("sender_id is required");
      access.allowFrom = (access.allowFrom || []).filter(
        (x) => normalizeId(x) !== normalizeId(sender_id),
      );
      store.saveAccess(access);
      text = `removed ${sender_id}`;
    } else if (action === "policy") {
      if (!value) throw new Error("value is required");
      access.dmPolicy = value;
      store.saveAccess(access);
      text = `dmPolicy=${value}`;
    } else if (action === "group-allow") {
      if (!value) throw new Error("value is required");
      access.groupAllowFrom = Array.from(
        new Set([...(access.groupAllowFrom || []), normalizeId(value)]),
      );
      store.saveAccess(access);
      text = `groupAllowFrom += ${value}`;
    } else if (action === "team-allow") {
      if (!value) throw new Error("value is required");
      access.teamAllowFrom = Array.from(
        new Set([...(access.teamAllowFrom || []), normalizeId(value)]),
      );
      store.saveAccess(access);
      text = `teamAllowFrom += ${value}`;
    }
    return { content: [{ type: "text", text }] };
  },
);

server.registerTool(
  "tuitui_debug_status",
  {
    description: "Inspect bridge runtime status and local state paths.",
    inputSchema: {},
  },
  async () => {
    const meta = store.loadMeta();
    const access = store.loadAccess();
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              stateDir,
              meta,
              accessSummary: {
                dmPolicy: access.dmPolicy,
                allowFrom: access.allowFrom?.length || 0,
                groupAllowFrom: access.groupAllowFrom?.length || 0,
                teamAllowFrom: access.teamAllowFrom?.length || 0,
                pending: Object.keys(access.pending || {}).length,
              },
              permissionRelaySummary: {
                lastDeliveredChat: meta.lastDeliveredChat,
                lastPermissionRequestAt: meta.lastPermissionRequestAt,
                lastPermissionRelay: meta.lastPermissionRelay,
                lastPermissionDecisionAt: meta.lastPermissionDecisionAt,
                lastPermissionDecision: meta.lastPermissionDecision,
                lastPermissionPersistAt: meta.lastPermissionPersistAt,
                lastPermissionPersist: meta.lastPermissionPersist,
              },
            },
            null,
            2,
          ),
        },
      ],
      structuredContent: { stateDir, meta, access },
    };
  },
);

const PermissionRequestSchema = z.object({
  method: z.literal("notifications/claude/channel/permission_request"),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
});

server.server.setNotificationHandler(
  PermissionRequestSchema,
  async ({ params }) => {
    try {
      await relayPermissionRequest(params);
    } catch (err) {
      traceNotify("permission_request:error", {
        requestId: params?.request_id,
        error: err?.message || String(err),
      });
      console.error(
        "[tuitui-channel] permission relay failed",
        err?.message || err,
      );
    }
  },
);

async function main() {
  logBoot("[BOOT] main() starting");
  ensureWs();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logBoot("[BOOT] server.connect completed");
  console.error("[tuitui-channel] MCP server running");
}

main()
  .then(() => {
    logBoot("[BOOT] main resolved");
  })
  .catch((err) => {
    logBoot(`[BOOT] fatal ${err?.stack || err}`);
    console.error("[tuitui-channel] fatal", err);
    process.exit(1);
  });
