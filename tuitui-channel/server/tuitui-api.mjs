import { readFileSync, existsSync, statSync } from "node:fs";
import { basename } from "node:path";
import WebSocket from "ws";

const TUITUI_HOST = "https://im.live.360.cn:8282";

export const CHAT_TYPE_DIRECT = "direct";
export const CHAT_TYPE_GROUP = "group";
export const CHAT_TYPE_CHANNEL = "channel";

export function addParams2Url(urlStr, params) {
  const url = new URL(urlStr);
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== "")
      url.searchParams.set(k, String(v));
  }
  return url.toString();
}

export function teamsBuildChatId(team_id, channel_id, thread_id) {
  return `teams_${team_id}_${channel_id}_${thread_id}`;
}

export function teamsParseChatId(chatId) {
  const [team_id, channel_id, parent_id] = String(chatId)
    .replace(/^teams_/, "")
    .split("_");
  if (!team_id || !channel_id || !parent_id)
    throw new Error(`Invalid teams chat ID: ${chatId}`);
  return { team_id, channel_id, parent_id, post_id: "" };
}

export function teamsBuildReplyTarget(
  team_id,
  channel_id,
  parent_id,
  post_id = "",
) {
  if (!team_id || !channel_id || !parent_id) {
    throw new Error(
      `Invalid teams reply target: ${team_id || ""}/${channel_id || ""}/${parent_id || ""}`,
    );
  }
  return { team_id, channel_id, parent_id, post_id };
}

export function guessChatType(chatId) {
  if (String(chatId).startsWith("teams_")) return CHAT_TYPE_CHANNEL;
  if (/^\d+$/.test(String(chatId))) return CHAT_TYPE_GROUP;
  return CHAT_TYPE_DIRECT;
}

function mimeFromFilename(filename) {
  const ext = String(filename).split(".").pop()?.toLowerCase();
  const map = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    pdf: "application/pdf",
    txt: "text/plain",
    json: "application/json",
    mp3: "audio/mpeg",
    mp4: "video/mp4",
  };
  return map[ext] || "application/octet-stream";
}

async function postJson(account, path, payload, auditCtx = "tuitui.post") {
  const url = addParams2Url(`${TUITUI_HOST}${path}`, {
    appid: account.appId,
    secret: account.appSecret,
  });
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let parsed = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {}
  if (!res.ok)
    throw new Error(
      `${auditCtx} failed: ${res.status} ${res.statusText} ${text}`,
    );
  if (Number(parsed.errcode || 0) !== 0)
    throw new Error(
      `${auditCtx} errcode=${parsed.errcode} errmsg=${parsed.errmsg || "unknown"}`,
    );
  return parsed;
}

function getTargets(chatId, chatType, targetOverrides = undefined) {
  if (chatType === CHAT_TYPE_DIRECT) return { tousers: [chatId] };
  if (chatType === CHAT_TYPE_GROUP) return { togroups: [chatId] };
  return {
    toteams: [targetOverrides || teamsParseChatId(chatId)],
  };
}

function getMentionsRegex() {
  return /(?<=^|[\s\r\n\u3000\u3001\u3002\uFF0C\uFF01\uFF1F\u2026])@([^\s]+)/g;
}

function extractMentions(text) {
  const mentions = [];
  const regex = getMentionsRegex();
  let match;
  while ((match = regex.exec(text)) !== null) {
    if (!mentions.includes(match[1])) mentions.push(match[1]);
  }
  return mentions;
}

function replaceMentions(text) {
  return String(text).replace(
    getMentionsRegex(),
    (_, mention) => `{{tuitui_at \"${mention}\"}}`,
  );
}

function replaceSingleNewlines(content) {
  return String(content).replace(/([^\n])\n([^\n])/g, "$1\n\n$2");
}

export function buildMessageBody(data = {}) {
  const parts = [];
  const pushImgs = (imgs) => {
    if (!imgs?.length) return;
    if (imgs.length === 1) parts.push(`[图片] ${imgs[0]}`);
    else {
      parts.push(`[图片] 共 ${imgs.length} 张图片:`);
      imgs.forEach((url, i) => parts.push(`  ${i + 1}. ${url}`));
    }
  };
  switch (data.msg_type) {
    case "text":
      parts.push(data.text || "");
      break;
    case "mixed":
      parts.push(data.text || "");
      pushImgs(data.images);
      break;
    case "image":
      pushImgs(data.images);
      break;
    case "voice":
      if (data.voice) parts.push(`[语音] ${data.voice}`);
      break;
    case "file":
      if (data.file) parts.push(`[文件] ${data.file.name}: ${data.file.url}`);
      break;
  }
  if (data.ref) {
    const ref = data.ref;
    const refText =
      ref.text ||
      ref.file?.url ||
      ref.images?.join("\n") ||
      `[${ref.msg_type}]`;
    parts.push(`\n[引用来自 ${ref.user_name} 的消息]\n${refText}`);
  }
  return parts.join("\n").trim();
}

export async function sendTextMsg(
  account,
  chatId,
  chatType,
  content,
  options = {},
) {
  if (!chatId) throw new Error("Missing chatId");
  const teamsTarget =
    chatType === CHAT_TYPE_CHANNEL && options.reply_to_post_id
      ? (() => {
          const parsed = teamsParseChatId(chatId);
          return teamsBuildReplyTarget(
            parsed.team_id,
            parsed.channel_id,
            parsed.parent_id,
            options.reply_to_post_id,
          );
        })()
      : undefined;
  if (chatType === CHAT_TYPE_CHANNEL) {
    const markdown = replaceMentions(replaceSingleNewlines(content));
    return postJson(
      account,
      "/robot/message/custom/send",
      {
        ...getTargets(chatId, chatType, teamsTarget),
        msgtype: "richtext/markdown",
        richtext: {
          markdown,
          delims_left: markdown.includes("{{tuitui_at") ? "{{" : "",
          delims_right: markdown.includes("{{tuitui_at") ? "}}" : "",
        },
      },
      "tuitui.send.text",
    );
  }
  return postJson(
    account,
    "/robot/message/custom/send",
    {
      ...getTargets(chatId, chatType),
      msgtype: "text",
      at: chatType === CHAT_TYPE_GROUP ? extractMentions(content) : [],
      text: { content },
    },
    "tuitui.send.text",
  );
}

export async function uploadFileToTuiTui(fileSrc, account, type = "file") {
  let fileBuffer;
  let contentType;
  let filename;
  if (/^data:/.test(fileSrc)) {
    const matches = fileSrc.match(/^data:([^;,]*)(;base64)?,(.*)$/);
    if (!matches) throw new Error("Invalid data URL");
    contentType = matches[1] || "application/octet-stream";
    const data = matches[3];
    fileBuffer = matches[2]
      ? Buffer.from(data, "base64")
      : Buffer.from(decodeURIComponent(data));
    filename = `media_${Date.now()}.${contentType.split("/")[1] || "bin"}`;
  } else if (/^https?:/.test(fileSrc)) {
    const res = await fetch(fileSrc);
    if (!res.ok) throw new Error(`download failed ${res.status}`);
    fileBuffer = Buffer.from(await res.arrayBuffer());
    contentType = res.headers.get("content-type") || "application/octet-stream";
    filename = basename(new URL(fileSrc).pathname || "media");
  } else {
    if (!existsSync(fileSrc))
      throw new Error(`Local file not found: ${fileSrc}`);
    const stats = statSync(fileSrc);
    if (stats.size > 10 * 1024 * 1024)
      throw new Error(`File too large: ${fileSrc}`);
    fileBuffer = readFileSync(fileSrc);
    filename = basename(fileSrc);
    contentType = mimeFromFilename(filename);
  }
  const body = new FormData();
  body.append("media", new Blob([fileBuffer], { type: contentType }), filename);
  const url = addParams2Url(`${TUITUI_HOST}/robot/media/upload`, {
    appid: account.appId,
    secret: account.appSecret,
    type,
  });
  const res = await fetch(url, { method: "POST", body });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : {};
  if (!res.ok || Number(parsed.errcode || 0) !== 0 || !parsed.media_id) {
    throw new Error(`upload failed: ${text}`);
  }
  return { fid: parsed.media_id, filename };
}

export async function sendMediaMsg(account, chatId, chatType, mediaUrl) {
  const isImage =
    /^data:image\//i.test(mediaUrl) ||
    /\.(jpg|jpeg|png|gif|webp)(?:$|[?#])/i.test(mediaUrl);
  const { fid, filename } = await uploadFileToTuiTui(
    mediaUrl,
    account,
    isImage ? "image" : "file",
  );
  if (chatType === CHAT_TYPE_CHANNEL) {
    const markdown = isImage
      ? `![]({{tuitui_image \"${fid}\"}})`
      : `[${filename}]({{tuitui_file \"${fid}\"}})`;
    return postJson(
      account,
      "/robot/message/custom/send",
      {
        ...getTargets(chatId, chatType),
        msgtype: "richtext/markdown",
        richtext: { markdown, delims_left: "{{", delims_right: "}}" },
      },
      "tuitui.send.media",
    );
  }
  return postJson(
    account,
    "/robot/message/custom/send",
    {
      ...getTargets(chatId, chatType),
      msgtype: isImage ? "image" : "attachment",
      [isImage ? "image" : "attachment"]: { media_id: fid },
    },
    "tuitui.send.media",
  );
}

export async function emojiReaction(
  account,
  target,
  chatType,
  msgid,
  emoji = "收到",
) {
  const payload = {
    msgtype: "emoji_reaction",
    tousers: [],
    togroups: [],
    toteams: [],
    emoji_reaction: { emoji, cancel: false },
  };
  if (chatType === CHAT_TYPE_DIRECT)
    payload.tousers.push({ user: target, msgid });
  else if (chatType === CHAT_TYPE_GROUP)
    payload.togroups.push({ group: target, msgid });
  else {
    const team = teamsParseChatId(target);
    payload.toteams.push({ ...team, parent_id: "", post_id: msgid });
  }
  return postJson(
    account,
    "/robot/message/custom/modify",
    payload,
    "tuitui.react",
  );
}

export function createWebSocketClient(
  account,
  { onJson, onOpen, onClose, onError, logger = console } = {},
) {
  const wsUrl = `wss://im.live.360.cn:8282/robot/callback/ws?auth=${account.appId}.${account.appSecret}`;
  const ws = new WebSocket(wsUrl, { rejectUnauthorized: true });
  ws.on("open", () => onOpen?.());
  ws.on("error", (err) => onError?.(err));
  ws.on("close", (code, reason) => onClose?.(code, String(reason || "")));
  ws.on("message", async (buf) => {
    let json;
    try {
      json = JSON.parse(String(buf));
    } catch (err) {
      logger.warn?.("[tuitui] failed to parse ws frame", err);
      return;
    }
    try {
      const ack = json?.event_id || json?.header?.event_id;
      if (ack) {
        // TuiTui server expects { ack: <event_id> } rather than echoing event_id back.
        ws.send(JSON.stringify({ ack }));
      }
    } catch {}
    if (!json?.body?.event) return;
    await onJson?.(json);
  });
  return ws;
}
