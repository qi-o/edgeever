import { spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants as fsConstants, readFileSync, realpathSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION, RequestError } from "@agentclientprotocol/sdk";
import { waitForChildProcessSpawn } from "./child-process-start.mjs";

const ADAPTERS = {
  codex: { id: "codex", label: "Codex" },
  antigravity: { id: "antigravity", label: "Antigravity" },
};
const AUTH_REQUIRED_CODE = -32000;
const MAX_ATTACHMENTS = 8;
const MAX_ATTACHMENT_CHARS = 8_000_000;
const HANDSHAKE_TIMEOUT_MS = 20_000;
const WORKSPACE_MARKER = `${path.sep}edgeever-acp-`;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

const liveChildren = new Set();
let exitHooked = false;

const clientVersion = () => {
  try {
    const version = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
    return typeof version === "string" && version.trim() ? version.trim() : "0.0.0";
  } catch {
    return "0.0.0";
  }
};

const trackChild = (child) => {
  if (!child) return;
  liveChildren.add(child);
  child.once?.("exit", () => liveChildren.delete(child));
  if (!exitHooked) {
    exitHooked = true;
    process.once("exit", () => {
      for (const live of liveChildren) {
        try { live.kill("SIGKILL"); } catch { /* already gone */ }
      }
    });
  }
};

export const codexBasenames = (platform = process.platform) => (
  platform === "win32" ? ["codex-acp", "codex-acp.exe"] : ["codex-acp"]
);

const slashRejected = (value) => value.includes("/") || value.includes("\\") || value.includes("\0");

const findOnPath = (names, { access, pathEnv, delimiter, sep }) => {
  for (const dir of String(pathEnv ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      if (slashRejected(name)) continue;
      const candidate = dir.endsWith("/") || dir.endsWith("\\") ? `${dir}${name}` : `${dir}${sep}${name}`;
      try {
        access(candidate, fsConstants.X_OK);
        return candidate;
      } catch {
        // Try the next PATH entry.
      }
    }
  }
  return null;
};

const resolutionDeps = (deps = {}) => ({
  platform: deps.platform ?? process.platform,
  access: deps.accessSync ?? accessSync,
  realpath: deps.realpathSync ?? realpathSync,
  stat: deps.statSync ?? statSync,
  pathEnv: deps.pathEnv ?? process.env.PATH ?? "",
  delimiter: deps.delimiter ?? path.delimiter,
  sep: deps.sep ?? path.sep,
});

export function resolveAcpCommand(input, deps = {}) {
  const resolved = resolutionDeps(deps);
  const id = input?.id;
  if (id !== "codex" && id !== "antigravity") return { ok: false, state: "failed", detail: "unknown_adapter" };
  if (id === "codex") return resolveCodex(input?.path, resolved);
  return resolveAntigravity(input?.path, resolved);
}

function resolveCodex(configured, deps) {
  const allowed = codexBasenames(deps.platform);
  let names = allowed;
  if (typeof configured === "string" && configured.trim()) {
    const name = configured.trim();
    if (slashRejected(name) || !allowed.includes(name)) return { ok: false, state: "failed", detail: "invalid_path" };
    names = [name];
  }
  const command = findOnPath(names, deps);
  return command ? { ok: true, command } : { ok: false, state: "not_installed" };
}

function resolveAntigravity(configured, { realpath, stat }) {
  if (typeof configured !== "string" || !configured.trim()) return { ok: false, state: "not_installed" };
  const raw = configured.trim();
  if (raw.includes("\0") || !path.isAbsolute(raw) || raw.split(/[/\\]/).includes("..")) {
    return { ok: false, state: "failed", detail: "invalid_path" };
  }
  let resolvedPath;
  try {
    resolvedPath = realpath(raw);
  } catch (error) {
    return error?.code === "ENOENT"
      ? { ok: false, state: "not_installed" }
      : { ok: false, state: "failed", detail: "invalid_path" };
  }
  let info;
  try {
    info = stat(resolvedPath);
  } catch (error) {
    return error?.code === "ENOENT"
      ? { ok: false, state: "not_installed" }
      : { ok: false, state: "failed", detail: "invalid_path" };
  }
  if (typeof info?.isFile !== "function" || !info.isFile()) return { ok: false, state: "failed", detail: "invalid_path" };
  return { ok: true, command: resolvedPath };
}

export function isAuthRequiredError(error) {
  if (!error) return false;
  const message = error instanceof Error ? error.message : String(error?.message ?? error);
  if (/auth/i.test(message)) return true;
  return error instanceof RequestError && error.code === AUTH_REQUIRED_CODE;
}

export function sanitizeFailureDetail(error) {
  const message = error instanceof Error ? error.message : String(error?.message ?? error ?? "");
  let text = message.replace(/\s+/g, " ").trim();
  const home = homedir();
  if (home && home !== "/" && home !== "\\") text = text.split(home).join("[path]");
  text = text.replace(/~\/[^\s]+/g, "[path]");
  text = text.replace(/(?:\/[\w.+@-]+){2,}/g, "[path]");
  text = text.replace(/[A-Za-z]:\\(?:[^\\/:*?"<>|\r\n]+\\)*[^\\/:*?"<>|\r\n]*/g, "[path]");
  text = text.replace(/\b(?:[A-Za-z0-9_]*(?:key|token|secret|password|credential)[A-Za-z0-9_]*)=[^\s]+/gi, "[redacted]");
  text = text.replace(/\b(?:bearer|authorization)\s+[^\s]+/gi, "[redacted]");
  text = text.replace(/\s+/g, " ").trim();
  if (!text || text === "[path]" || text === "[redacted]") return "connection_failed";
  return text.slice(0, 160);
}

export function classifyAcpFailure(error) {
  if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return { state: "not_installed" };
  if (error?.code === "TIMEOUT" || error?.message === "connection_timeout") {
    return { state: "failed", detail: "connection_timeout" };
  }
  if (isAuthRequiredError(error)) return { state: "needs_login" };
  return { state: "failed", detail: sanitizeFailureDetail(error) };
}

const adapterShell = (id) => ({ ...ADAPTERS[id] });

const adapterFromResolution = (id, resolution) => {
  const adapter = adapterShell(id);
  if (!resolution.ok && resolution.state === "failed") {
    return { ...adapter, state: "failed", detail: resolution.detail || "connection_failed" };
  }
  if (!resolution.ok) return { ...adapter, state: "not_installed" };
  return adapter;
};

const mediaTypeBase = (value) => (
  typeof value === "string" ? value.split(";")[0].trim().toLowerCase() : ""
);

const attachmentToken = (filename) => {
  const base = String(filename ?? "").split(/[/\\]/).filter(Boolean).pop() ?? "";
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "").slice(0, 80);
  return cleaned || "attachment";
};

const decodeText = (dataBase64) => Buffer.from(dataBase64, "base64").toString("utf8");

const rejectAttachment = (attachment, reason) => ({
  filename: typeof attachment?.filename === "string" && attachment.filename ? attachment.filename : "attachment",
  reason,
});

export function buildPromptContent({ prompt, contextText, attachments, promptCapabilities = {} } = {}) {
  const blocks = [];
  const rejectedAttachments = [];
  if (typeof contextText === "string" && contextText.length > 0) blocks.push({ type: "text", text: contextText });
  blocks.push({ type: "text", text: typeof prompt === "string" ? prompt : "" });
  const list = Array.isArray(attachments) ? attachments : [];
  list.forEach((attachment, index) => {
    if (index >= MAX_ATTACHMENTS) {
      rejectedAttachments.push(rejectAttachment(attachment, "Too many attachments."));
      return;
    }
    const mapped = mapAttachment(attachment, promptCapabilities);
    if (mapped.block) blocks.push(mapped.block);
    if (mapped.rejected) rejectedAttachments.push(mapped.rejected);
  });
  assertPromptBlocksSafe(blocks);
  return { blocks, rejectedAttachments };
}

function mapAttachment(attachment, capabilities) {
  if (!attachment || typeof attachment !== "object") {
    return { rejected: rejectAttachment(attachment, "This attachment could not be read.") };
  }
  const dataBase64 = attachment.dataBase64;
  if (typeof dataBase64 !== "string" || dataBase64.length > MAX_ATTACHMENT_CHARS) {
    return { rejected: rejectAttachment(attachment, "This attachment could not be read.") };
  }
  const mediaType = mediaTypeBase(attachment.mediaType);
  if (mediaType.startsWith("text/") || mediaType === "application/json") {
    return { block: { type: "text", text: decodeText(dataBase64) } };
  }
  if (IMAGE_TYPES.has(mediaType)) {
    if (capabilities.image !== true) {
      return { rejected: rejectAttachment(attachment, "This agent does not accept images.") };
    }
    return { block: { type: "image", data: dataBase64, mimeType: mediaType } };
  }
  if (mediaType === "application/pdf") {
    if (capabilities.embeddedContext !== true) {
      return { rejected: rejectAttachment(attachment, "This agent does not accept embedded files.") };
    }
    return {
      block: {
        type: "resource",
        resource: {
          uri: `edgeever-attachment:${attachmentToken(attachment.filename)}`,
          blob: dataBase64,
          mimeType: "application/pdf",
        },
      },
    };
  }
  return { rejected: rejectAttachment(attachment, "This file type is not supported.") };
}

function assertPromptBlocksSafe(blocks) {
  for (const block of blocks) {
    if (!block || block.type === "resource_link") throw new Error("invalid_prompt");
    if (block.type === "resource") {
      const uri = block.resource?.uri ?? "";
      if (!uri.startsWith("edgeever-attachment:") || /[/\\]/.test(uri) || uri.includes("..")) {
        throw new Error("invalid_prompt");
      }
    }
    if (block.type === "image" && typeof block.uri === "string") throw new Error("invalid_prompt");
  }
}

const safeToolToken = (value) => {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 120 || /[/\\]/.test(trimmed) || trimmed.includes("://")) return "";
  return trimmed;
};

export function eventsFromSessionUpdate(requestId, params) {
  const update = params?.update;
  if (!update || typeof update !== "object") return [];
  if (update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "agent_thought_chunk") {
    if (update.content?.type !== "text" || typeof update.content.text !== "string" || update.content.text.length === 0) {
      return [];
    }
    return [{
      requestId,
      type: update.sessionUpdate === "agent_message_chunk" ? "text-delta" : "reasoning",
      text: update.content.text,
    }];
  }
  if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") return [];
  const name = safeToolToken(update.name) || safeToolToken(update.toolCallId) || "tool";
  const status = safeToolToken(update.status) || "pending";
  const event = { requestId, type: "tool", name, status };
  const title = safeToolToken(update.title);
  if (title) event.title = title;
  return [event];
}

export function acpInitializeParams(version = clientVersion()) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    },
    clientInfo: { name: "edgeever", version },
  };
}

export function createAcpSpawnPlan(command, cwd) {
  if (typeof command !== "string" || !command.trim() || command.includes("\0")) throw new Error("invalid_command");
  if (typeof cwd !== "string" || !cwd.trim()) throw new Error("invalid_workspace");
  const workspace = path.resolve(cwd);
  if (workspace === path.resolve(homedir())) throw new Error("invalid_workspace");
  return {
    command,
    args: [],
    options: {
      cwd: workspace,
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
      shell: false,
    },
  };
}

export function spawnAcpChild(spawnImpl, command, cwd) {
  const plan = createAcpSpawnPlan(command, cwd);
  const options = { ...plan.options, shell: false, stdio: ["pipe", "pipe", "ignore"] };
  if (options.shell !== false) throw new Error("ACP processes cannot use a shell");
  const child = spawnImpl(plan.command, [], options);
  trackChild(child);
  return waitForChildProcessSpawn(child);
}

// Bun's test runner makes Readable.toWeb end a child pipe before any bytes arrive.
// Electron (Node) keeps the official Writable.toWeb / Readable.toWeb conversion.
const useBunStdioBridge = typeof process.versions?.bun === "string";

export function nodeReadableToWeb(nodeStream) {
  let settled = false;
  return new ReadableStream({
    start(controller) {
      const close = () => {
        if (settled) return;
        settled = true;
        try { controller.close(); } catch { /* already closed */ }
      };
      const fail = (error) => {
        if (settled) return;
        settled = true;
        try { controller.error(error); } catch { /* already closed */ }
      };
      nodeStream.on("data", (chunk) => {
        if (settled) return;
        const bytes = chunk instanceof Uint8Array ? chunk : Buffer.from(String(chunk));
        try { controller.enqueue(bytes); } catch { /* closed */ }
      });
      nodeStream.on("end", close);
      nodeStream.on("error", fail);
    },
    cancel() {
      settled = true;
    },
  });
}

export function nodeWritableToWeb(nodeStream) {
  return new WritableStream({
    write(chunk) {
      return new Promise((resolve, reject) => {
        try {
          nodeStream.write(Buffer.from(chunk), (error) => (error ? reject(error) : resolve()));
        } catch (error) {
          reject(error);
        }
      });
    },
    close() {
      return new Promise((resolve, reject) => {
        try {
          nodeStream.end((error) => (error ? reject(error) : resolve()));
        } catch (error) {
          reject(error);
        }
      });
    },
  });
}

const acpNdJsonStream = (child) => {
  if (!child?.stdin || !child?.stdout) throw new Error("stdio_bridge_unavailable");
  if (!useBunStdioBridge && typeof Writable.toWeb === "function" && typeof Readable.toWeb === "function") {
    return ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
  }
  return ndJsonStream(nodeWritableToWeb(child.stdin), nodeReadableToWeb(child.stdout));
};

export async function createAcpWorkspace(mkdtempImpl = mkdtemp, root = tmpdir()) {
  const resolvedRoot = path.resolve(root);
  if (resolvedRoot === path.resolve(homedir())) throw new Error("invalid_workspace");
  const directory = await mkdtempImpl(path.join(resolvedRoot, "edgeever-acp-"));
  if (path.resolve(directory) === path.resolve(homedir())) throw new Error("invalid_workspace");
  return directory;
}

export async function removeAcpWorkspace(directory, rmImpl = rm) {
  if (typeof directory !== "string" || !directory) return;
  const resolved = path.resolve(directory);
  if (resolved === path.resolve(homedir()) || !resolved.includes(WORKSPACE_MARKER)) return;
  await rmImpl(resolved, { recursive: true, force: true });
}

const normalizePromptCapabilities = (initialized) => {
  const caps = initialized?.agentCapabilities?.promptCapabilities ?? {};
  return {
    image: caps.image === true,
    embeddedContext: caps.embeddedContext === true,
  };
};

const createEdgeEverAcpClient = (requestId, emit) => ({
  requestPermission() {
    return { outcome: { outcome: "cancelled" } };
  },
  sessionUpdate(params) {
    for (const event of eventsFromSessionUpdate(requestId, params)) emit(event);
  },
  readTextFile() {
    throw new Error("filesystem access is not available");
  },
  writeTextFile() {
    throw new Error("filesystem access is not available");
  },
  createTerminal() {
    throw new Error("terminal access is not available");
  },
  terminalOutput() {
    throw new Error("terminal access is not available");
  },
  releaseTerminal() {
    throw new Error("terminal access is not available");
  },
  waitForTerminalExit() {
    throw new Error("terminal access is not available");
  },
  killTerminal() {
    throw new Error("terminal access is not available");
  },
});

function stopChild(child) {
  if (!child) return;
  const killTimer = setTimeout(() => {
    if (child.exitCode == null) {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }
  }, 500);
  killTimer.unref?.();
  child.once?.("exit", () => clearTimeout(killTimer));
  try { child.stdin?.destroy(); } catch { /* closed */ }
  try { child.kill("SIGTERM"); } catch { /* already gone */ }
}

const promptFailureMessage = (failure) => {
  if (failure.state === "not_installed") return "not_installed";
  if (failure.state === "needs_login") return "needs_login";
  return failure.detail || "connection_failed";
};

export function createAcpHostRuntime(options = {}) {
  const spawnImpl = options.spawnImpl ?? nodeSpawn;
  const mkdtempImpl = options.mkdtemp ?? mkdtemp;
  const rmImpl = options.rm ?? rm;
  const version = options.clientVersion ?? clientVersion();
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS;
  const commandDeps = options;
  const active = new Map();

  const connect = async (command, requestId, emit, signal) => {
    const cwd = await createAcpWorkspace(mkdtempImpl, options.tmpRoot);
    let child = null;
    const abort = () => stopChild(child);
    signal?.addEventListener("abort", abort, { once: true });
    try {
      if (signal?.aborted) throw Object.assign(new Error("connection_timeout"), { code: "TIMEOUT" });
      child = await spawnAcpChild(spawnImpl, command, cwd);
      if (signal?.aborted) throw Object.assign(new Error("connection_timeout"), { code: "TIMEOUT" });
      const stream = acpNdJsonStream(child);
      const connection = new ClientSideConnection(() => createEdgeEverAcpClient(requestId, emit), stream);
      void connection.closed?.catch(() => {});
      const initialized = await connection.initialize(acpInitializeParams(version));
      const session = await connection.newSession({ cwd, mcpServers: [] });
      if (signal?.aborted) throw Object.assign(new Error("connection_timeout"), { code: "TIMEOUT" });
      return {
        cwd,
        child,
        connection,
        sessionId: session.sessionId,
        promptCapabilities: normalizePromptCapabilities(initialized),
        stop: abort,
      };
    } catch (error) {
      abort();
      await removeAcpWorkspace(cwd, rmImpl);
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  };

  const withHandshakeTimeout = async (operation) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), handshakeTimeoutMs);
    timer.unref?.();
    try {
      return await operation(controller.signal);
    } catch (error) {
      if (controller.signal.aborted && !isAuthRequiredError(error) && error?.code !== "ENOENT") {
        throw Object.assign(new Error("connection_timeout"), { code: "TIMEOUT" });
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    listAdapters() {
      const codex = resolveAcpCommand({ id: "codex" }, commandDeps);
      const codexAdapter = codex.ok
        ? { ...adapterShell("codex"), state: "failed", detail: "not_probed" }
        : adapterFromResolution("codex", codex);
      return [codexAdapter, { ...adapterShell("antigravity"), state: "not_installed" }];
    },

    async probeAdapter(input) {
      const id = input?.id;
      if (id !== "codex" && id !== "antigravity") throw new Error("unknown_adapter");
      const resolved = resolveAcpCommand(input, commandDeps);
      if (!resolved.ok) return adapterFromResolution(id, resolved);
      let connected;
      try {
        connected = await withHandshakeTimeout((signal) => connect(resolved.command, `probe-${id}`, () => {}, signal));
      } catch (error) {
        return { ...adapterShell(id), ...failureFields(classifyAcpFailure(error)) };
      }
      const adapter = {
        ...adapterShell(id),
        state: "available",
        promptCapabilities: connected.promptCapabilities,
      };
      connected.stop();
      await removeAcpWorkspace(connected.cwd, rmImpl);
      return adapter;
    },

    async prompt(input, emit = () => {}) {
      if (!input || typeof input !== "object" || typeof input.prompt !== "string") throw new Error("invalid_prompt");
      if (input.adapterId !== "codex" && input.adapterId !== "antigravity") throw new Error("unknown_adapter");
      const requestId = randomUUID();
      const notify = (event) => emit(event);
      const fail = (message) => {
        notify({ requestId, type: "error", message });
        return { requestId };
      };
      const resolved = resolveAcpCommand({ id: input.adapterId, path: input.path }, commandDeps);
      if (!resolved.ok) return fail(promptFailureMessage(resolved));

      let connected;
      try {
        connected = await withHandshakeTimeout((signal) => connect(resolved.command, requestId, notify, signal));
      } catch (error) {
        return fail(promptFailureMessage(classifyAcpFailure(error)));
      }

      let content;
      try {
        content = buildPromptContent({
          prompt: input.prompt,
          contextText: input.contextText,
          attachments: input.attachments,
          promptCapabilities: connected.promptCapabilities,
        });
      } catch (error) {
        connected.stop();
        await removeAcpWorkspace(connected.cwd, rmImpl);
        return fail(promptFailureMessage(classifyAcpFailure(error)));
      }

      const session = {
        cancelled: false,
        settled: false,
        ...connected,
      };
      active.set(requestId, session);
      const finish = (event) => {
        if (session.settled) return;
        session.settled = true;
        notify(event);
        session.stop();
        active.delete(requestId);
        void removeAcpWorkspace(session.cwd, rmImpl);
      };
      void connected.connection.prompt({ sessionId: connected.sessionId, prompt: content.blocks }).then(() => {
        finish({ requestId, type: "done" });
      }).catch((error) => {
        if (session.cancelled) finish({ requestId, type: "done" });
        else finish({ requestId, type: "error", message: promptFailureMessage(classifyAcpFailure(error)) });
      });
      return { requestId, rejectedAttachments: content.rejectedAttachments };
    },

    async cancel(requestId) {
      const session = active.get(requestId);
      if (!session) return { ok: true };
      session.cancelled = true;
      try {
        if (session.connection && session.sessionId) await session.connection.cancel({ sessionId: session.sessionId });
      } catch {
        // The process may already be gone. Killing it is enough.
      }
      session.stop();
      return { ok: true };
    },
  };
}

const failureFields = (failure) => (
  failure.state === "failed"
    ? { state: "failed", detail: failure.detail || "connection_failed" }
    : { state: failure.state }
);

export function registerAcpIpc(ipcMain, runtime = createAcpHostRuntime()) {
  const send = (sender, event) => {
    if (!sender || sender.isDestroyed?.()) return;
    sender.send("desktop:acp-event", event);
  };
  ipcMain.handle("desktop:acp-list", () => runtime.listAdapters());
  ipcMain.handle("desktop:acp-probe", (_event, input) => runtime.probeAdapter(input));
  ipcMain.handle("desktop:acp-prompt", (event, input) => runtime.prompt(input, (acpEvent) => send(event.sender, acpEvent)));
  ipcMain.handle("desktop:acp-cancel", (_event, requestId) => runtime.cancel(requestId));
  return runtime;
}
