import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  existsSync,
} from "node:fs";
import { dirname, join } from "node:path";
import crypto from "node:crypto";

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, data) {
  ensureDir(dirname(file));
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
}

function defaultMeta() {
  return {
    cursor: 0,
    lastWsConnectAt: 0,
    lastMessageAt: 0,
    lastDeliveredChat: null,
    lastPermissionRequestAt: 0,
    lastPermissionRelay: null,
    lastPermissionDecisionAt: 0,
    lastPermissionDecision: null,
    lastPermissionPersistAt: 0,
    lastPermissionPersist: null,
  };
}

export class StateStore {
  constructor(stateDir) {
    this.stateDir = stateDir;
    this.accessFile = join(stateDir, "access.json");
    this.inboxFile = join(stateDir, "inbox.jsonl");
    this.metaFile = join(stateDir, "meta.json");
    this.seenFile = join(stateDir, "seen.json");
    this.rawEventsFile = join(stateDir, "raw-events.jsonl");
    ensureDir(stateDir);
    if (!existsSync(this.accessFile)) {
      this.saveAccess({
        dmPolicy: process.env.TUITUI_DM_POLICY || "pairing",
        allowFrom: [],
        groupPolicy: process.env.TUITUI_GROUP_POLICY || "allowlist",
        groupAllowFrom: [],
        pending: {},
      });
    }
    if (!existsSync(this.metaFile)) this.saveMeta(defaultMeta());
    if (!existsSync(this.seenFile)) this.saveSeen({ keys: [] });
  }

  loadAccess() {
    return readJson(this.accessFile, {
      dmPolicy: "pairing",
      allowFrom: [],
      groupPolicy: "allowlist",
      groupAllowFrom: [],
      pending: {},
    });
  }
  saveAccess(data) {
    writeJsonAtomic(this.accessFile, data);
  }
  loadMeta() {
    return { ...defaultMeta(), ...readJson(this.metaFile, defaultMeta()) };
  }
  saveMeta(data) {
    writeJsonAtomic(this.metaFile, { ...defaultMeta(), ...(data || {}) });
  }
  loadSeen() {
    return readJson(this.seenFile, { keys: [] });
  }
  saveSeen(data) {
    writeJsonAtomic(this.seenFile, data);
  }

  appendRawEvent(event) {
    ensureDir(this.stateDir);
    appendFileSync(this.rawEventsFile, JSON.stringify(event) + "\n", {
      encoding: "utf8",
      mode: 0o600,
      flag: "a",
    });
  }

  hasSeen(key) {
    const seen = this.loadSeen();
    return (seen.keys || []).includes(key);
  }

  rememberSeen(key, maxKeys = 2000) {
    const seen = this.loadSeen();
    const keys = Array.isArray(seen.keys) ? seen.keys : [];
    if (!keys.includes(key)) keys.push(key);
    while (keys.length > maxKeys) keys.shift();
    this.saveSeen({ keys });
  }

  appendInbox(entry) {
    ensureDir(this.stateDir);
    const meta = this.loadMeta();
    meta.lastMessageAt = Date.now();
    meta.cursor = (meta.cursor || 0) + 1;
    this.saveMeta(meta);
    const row = { ...entry, cursor: meta.cursor };
    appendFileSync(this.inboxFile, JSON.stringify(row) + "\n", {
      encoding: "utf8",
      mode: 0o600,
      flag: "a",
    });
    return meta.cursor;
  }

  listMessages(limit = 20, unreadOnly = false, afterCursor = 0) {
    let rows = [];
    try {
      rows = readFileSync(this.inboxFile, "utf8")
        .trim()
        .split(/\n+/)
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch {}
    if (afterCursor)
      rows = rows.filter((x) => Number(x.cursor || 0) > Number(afterCursor));
    if (unreadOnly) rows = rows.filter((x) => !x.readAt);
    return rows.slice(-limit);
  }

  markRead(uptoCursor = Infinity) {
    let rows = [];
    try {
      rows = readFileSync(this.inboxFile, "utf8")
        .trim()
        .split(/\n+/)
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch {
      return 0;
    }
    let changed = 0;
    const now = Date.now();
    rows = rows.map((row) => {
      if (!row.readAt && Number(row.cursor || 0) <= uptoCursor) {
        changed += 1;
        return { ...row, readAt: now };
      }
      return row;
    });
    writeFileSync(
      this.inboxFile,
      rows.map((x) => JSON.stringify(x)).join("\n") + (rows.length ? "\n" : ""),
      "utf8",
    );
    return changed;
  }

  markMessageReplied(messageId, replyText) {
    let rows = [];
    try {
      rows = readFileSync(this.inboxFile, "utf8")
        .trim()
        .split(/\n+/)
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch {
      return 0;
    }
    let changed = 0;
    const now = Date.now();
    rows = rows.map((row) => {
      if (String(row.messageId) === String(messageId) && !row.repliedAt) {
        changed += 1;
        return { ...row, repliedAt: now, replyText };
      }
      return row;
    });
    writeFileSync(
      this.inboxFile,
      rows.map((x) => JSON.stringify(x)).join("\n") + (rows.length ? "\n" : ""),
      "utf8",
    );
    return changed;
  }

  createPairing(senderId, chatId) {
    const access = this.loadAccess();
    const code = crypto.randomBytes(3).toString("hex");
    access.pending ||= {};
    access.pending[code] = {
      senderId,
      chatId,
      createdAt: Date.now(),
      expiresAt: Date.now() + 3600_000,
      replies: 0,
    };
    this.saveAccess(access);
    return code;
  }

  approvePairing(code) {
    const access = this.loadAccess();
    const pending = access.pending?.[code];
    if (!pending) return null;
    access.allowFrom = Array.from(
      new Set([
        ...(access.allowFrom || []),
        String(pending.senderId).toLowerCase().trim(),
      ]),
    );
    delete access.pending[code];
    this.saveAccess(access);
    return pending;
  }
}
