import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { realpathSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { RequestError } from "@agentclientprotocol/sdk";
import {
  acpInitializeParams,
  buildPromptContent,
  classifyAcpFailure,
  createAcpHostRuntime,
  createAcpSpawnPlan,
  eventsFromSessionUpdate,
  isAuthRequiredError,
  registerAcpIpc,
  resolveAcpCommand,
  sanitizeFailureDetail,
  spawnAcpChild,
} from "./acp-host.mjs";

const require = createRequire(import.meta.url);
const sdkHref = pathToFileURL(require.resolve("@agentclientprotocol/sdk")).href;
const home = path.resolve(homedir());

const encode = (value) => Buffer.from(value).toString("base64");

const collector = () => {
  const events = [];
  let waiters = [];
  return {
    events,
    emit(event) {
      events.push(event);
      waiters = waiters.filter((waiter) => {
        if (!waiter.predicate(event)) return true;
        waiter.resolve(event);
        return false;
      });
    },
    waitFor(predicate, timeout = 5000) {
      const found = events.find(predicate);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`timed out; saw ${events.map((event) => event.type).join(",") || "nothing"}`));
        }, timeout);
        waiters.push({
          predicate,
          resolve: (event) => {
            clearTimeout(timer);
            resolve(event);
          },
        });
      });
    },
  };
};

const fakeAgentSource = ({ reportPath, secretPath, allowImage, allowEmbedded, hold }) => `#!/usr/bin/env bun
import * as acp from ${JSON.stringify(sdkHref)};
import { writeFileSync } from "node:fs";

const reportPath = ${JSON.stringify(reportPath)};
const secretPath = ${JSON.stringify(secretPath)};
const allowImage = ${allowImage ? "true" : "false"};
const allowEmbedded = ${allowEmbedded ? "true" : "false"};
const hold = ${hold ? "true" : "false"};
const report = { initialize: null, newSession: null, permission: null, readError: null, readResult: null, prompt: null };
const save = () => writeFileSync(reportPath, JSON.stringify(report));
writeFileSync(reportPath + ".pid", String(process.pid));
let releaseHold = () => {};
const released = new Promise((resolve) => {
  releaseHold = resolve;
});

const stream = acp.ndJsonStream(
  new WritableStream({
    write(chunk) {
      return new Promise((resolve, reject) => {
        process.stdout.write(Buffer.from(chunk), (error) => (error ? reject(error) : resolve()));
      });
    },
  }),
  new ReadableStream({
    start(controller) {
      process.stdin.on("data", (chunk) => {
        const bytes = chunk instanceof Uint8Array ? chunk : Buffer.from(String(chunk));
        try { controller.enqueue(bytes); } catch { /* closed */ }
      });
      process.stdin.on("end", () => {
        try { controller.close(); } catch { /* already closed */ }
      });
      process.stdin.on("error", (error) => {
        try { controller.error(error); } catch { /* already closed */ }
      });
    },
  }),
);

acp.agent({ name: "edgeever-fake-agent" })
  .onRequest("initialize", (ctx) => {
    report.initialize = ctx.params;
    save();
    return {
      protocolVersion: ctx.params.protocolVersion,
      agentCapabilities: { promptCapabilities: { image: allowImage, embeddedContext: allowEmbedded } },
    };
  })
  .onRequest("session/new", (ctx) => {
    report.newSession = { cwd: ctx.params.cwd, mcpServers: ctx.params.mcpServers };
    save();
    return { sessionId: "sess-1" };
  })
  .onRequest("session/prompt", async (ctx) => {
    report.prompt = ctx.params.prompt;
    save();
    await ctx.client.notify("session/update", {
      sessionId: ctx.params.sessionId,
      update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } },
    });
    await ctx.client.notify("session/update", {
      sessionId: ctx.params.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello from agent" } },
    });
    await ctx.client.notify("session/update", {
      sessionId: ctx.params.sessionId,
      update: { sessionUpdate: "tool_call", toolCallId: "call_1", name: "search", title: "Search notes", status: "pending" },
    });
    if (!hold) {
      try {
        const result = await ctx.client.request("fs/read_text_file", { sessionId: ctx.params.sessionId, path: secretPath });
        report.readResult = result?.content ?? result ?? null;
      } catch (error) {
        report.readError = error instanceof Error ? error.message : String(error);
        report.readResult = null;
      }
      report.permission = await ctx.client.request("session/request_permission", {
        sessionId: ctx.params.sessionId,
        toolCall: { toolCallId: "call_1", title: "Search notes", status: "pending" },
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
      });
      save();
      return { stopReason: "end_turn" };
    }
    await released;
    return { stopReason: "cancelled" };
  })
  .onNotification("session/cancel", () => {
    releaseHold();
  })
  .connect(stream);
`;

const writeFakeAgent = async (directory, options) => {
  const scriptPath = path.join(directory, "fake-agent.mjs");
  await writeFile(scriptPath, fakeAgentSource(options), "utf8");
  await chmod(scriptPath, 0o755);
  return scriptPath;
};

const waitUntilExited = async (pid) => {
  const started = Date.now();
  while (Date.now() - started < 3000) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`process ${pid} is still running`);
};

describe("ACP command allow-list", () => {
  test("rejects relative paths and basenames that contain a slash", () => {
    for (const configured of ["codex-acp/evil", "bin\\codex-acp", "../codex-acp", "./codex-acp"]) {
      const result = resolveAcpCommand({ id: "codex", path: configured }, { pathEnv: "", platform: "darwin" });
      expect(result.ok).toBe(false);
      expect(result.detail).toBe("invalid_path");
      expect(JSON.stringify(result)).not.toContain(configured);
    }
    expect(resolveAcpCommand({ id: "antigravity", path: "agy" }).ok).toBe(false);
    expect(resolveAcpCommand({ id: "antigravity", path: "relative/agy" }).detail).toBe("invalid_path");
    expect(resolveAcpCommand({ id: "antigravity", path: "../agy" }).detail).toBe("invalid_path");
    expect(JSON.stringify(resolveAcpCommand({ id: "antigravity", path: "/tmp/../agy" }))).not.toContain("/tmp/../agy");
  });

  test("lists Codex from PATH presence without marking it available", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "edgeever-acp-path-"));
    try {
      const binary = path.join(directory, "codex-acp");
      await writeFile(binary, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      const present = createAcpHostRuntime({ pathEnv: directory, platform: "darwin", sep: path.sep, delimiter: path.delimiter });
      const listed = present.listAdapters();
      expect(listed.find((adapter) => adapter.id === "codex")).toEqual({
        id: "codex",
        label: "Codex",
        state: "failed",
        detail: "not_probed",
      });
      expect(listed.find((adapter) => adapter.id === "antigravity")?.state).toBe("not_installed");
      expect(JSON.stringify(listed)).not.toContain(directory);

      const missing = createAcpHostRuntime({ pathEnv: "", platform: "darwin" });
      expect(missing.listAdapters().find((adapter) => adapter.id === "codex")?.state).toBe("not_installed");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("looks up codex-acp.exe only as a win32 basename", () => {
    const seen = [];
    resolveAcpCommand({ id: "codex" }, {
      platform: "win32",
      pathEnv: "C:\\Tools",
      delimiter: ";",
      sep: "\\",
      accessSync(candidate) {
        seen.push(candidate);
        const error = new Error("missing");
        error.code = "ENOENT";
        throw error;
      },
    });
    expect(seen).toEqual(["C:\\Tools\\codex-acp", "C:\\Tools\\codex-acp.exe"]);
  });

  test("requires an Antigravity absolute file and does not accept a directory", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "edgeever-acp-agy-"));
    try {
      const file = path.join(directory, "antigravity-acp");
      await writeFile(file, "", { mode: 0o755 });
      const fileResult = resolveAcpCommand({ id: "antigravity", path: file });
      expect(fileResult).toEqual({ ok: true, command: realpathSync(file) });
      expect(resolveAcpCommand({ id: "antigravity", path: directory })).toMatchObject({ ok: false, detail: "invalid_path" });
      const missing = resolveAcpCommand({ id: "antigravity", path: path.join(directory, "missing-binary") });
      expect(missing).toEqual({ ok: false, state: "not_installed" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("ACP prompt blocks", () => {
  const image = { filename: "pic.png", mediaType: "image/png", dataBase64: encode("png-bytes") };
  const pdf = { filename: "/Users/me/secret.pdf", mediaType: "application/pdf", dataBase64: encode("%PDF-1.7") };
  const note = { filename: "/tmp/notes/body.txt", mediaType: "text/plain", dataBase64: encode("hello notes") };

  test("omits images and PDFs until the agent advertises those capabilities", () => {
    const blocked = buildPromptContent({
      prompt: "go",
      contextText: "ctx",
      attachments: [image, pdf, note, { filename: "song.mp3", mediaType: "audio/mpeg", dataBase64: encode("nope") }],
      promptCapabilities: {},
    });
    expect(blocked.blocks.map((block) => block.type)).toEqual(["text", "text", "text"]);
    expect(blocked.blocks.map((block) => block.text)).toEqual(["ctx", "go", "hello notes"]);
    expect(blocked.rejectedAttachments.map((item) => item.reason)).toEqual([
      "This agent does not accept images.",
      "This agent does not accept embedded files.",
      "This file type is not supported.",
    ]);
    expect(JSON.stringify(blocked.blocks)).not.toContain("/Users/me/secret.pdf");
    expect(JSON.stringify(blocked.blocks)).not.toContain("/tmp/notes/body.txt");
    expect(JSON.stringify(blocked.blocks)).not.toContain("resource_link");
  });

  test("includes images and embedded PDFs without a filesystem path", () => {
    const allowed = buildPromptContent({
      prompt: "go",
      attachments: [image, pdf],
      promptCapabilities: { image: true, embeddedContext: true },
    });
    const picture = allowed.blocks.find((block) => block.type === "image");
    const resource = allowed.blocks.find((block) => block.type === "resource");
    expect(picture).toEqual({ type: "image", data: image.dataBase64, mimeType: "image/png" });
    expect(resource.resource.uri).toBe("edgeever-attachment:secret.pdf");
    expect(resource.resource.mimeType).toBe("application/pdf");
    expect(resource.resource.blob).toBe(pdf.dataBase64);
    const serialized = JSON.stringify(allowed.blocks);
    expect(serialized).not.toContain("/Users/me");
    expect(serialized).not.toContain("file:");
    expect(serialized).not.toContain("resource_link");
    expect(allowed.rejectedAttachments).toEqual([]);
  });
});

describe("ACP spawn and failure mapping", () => {
  test("forces shell false and refuses the home directory as cwd", async () => {
    const source = await Bun.file(new URL("./acp-host.mjs", import.meta.url)).text();
    expect(source).toContain("shell: false");
    expect(source).not.toContain("shell: true");
    expect(() => createAcpSpawnPlan("/bin/echo", home)).toThrow(/invalid_workspace/);
    const workspace = await mkdtemp(path.join(tmpdir(), "edgeever-acp-spawn-"));
    const child = new EventEmitter();
    let captured;
    const spawned = spawnAcpChild((command, args, options) => {
      captured = { command, args, options };
      queueMicrotask(() => child.emit("spawn"));
      return child;
    }, "/opt/codex-acp", workspace);
    await spawned;
    expect(captured).toEqual({
      command: "/opt/codex-acp",
      args: [],
      options: expect.objectContaining({ shell: false, cwd: path.resolve(workspace) }),
    });
    expect(captured.options.shell).toBe(false);
    expect(captured.options.stdio).toEqual(["pipe", "pipe", "ignore"]);
    await rm(workspace, { recursive: true, force: true });
  });

  test("maps auth, missing binaries, and strips home paths from details", () => {
    expect(isAuthRequiredError(RequestError.authRequired())).toBe(true);
    expect(isAuthRequiredError(new Error("session failed: auth_required"))).toBe(true);
    expect(isAuthRequiredError(new Error("connection reset"))).toBe(false);
    expect(classifyAcpFailure(Object.assign(new Error(`spawn ${home}/bin ENOENT`), { code: "ENOENT" })).state).toBe("not_installed");
    const detail = sanitizeFailureDetail(new Error(`failed ${home}/.gemini/oauth TOKEN=abc Bearer secret-value`));
    expect(detail).not.toContain(home);
    expect(detail).not.toContain("TOKEN=abc");
    expect(detail).not.toContain("secret-value");
    expect(detail).not.toContain(".gemini");
  });

  test("client capabilities do not enable filesystem or terminal access", () => {
    expect(acpInitializeParams("1.2.3")).toEqual({
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: "edgeever", version: "1.2.3" },
    });
  });

  test("maps text, reasoning, and tool progress without diff payloads", () => {
    expect(eventsFromSessionUpdate("r1", {
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } },
    })).toEqual([{ requestId: "r1", type: "text-delta", text: "hello" }]);
    expect(eventsFromSessionUpdate("r1", {
      update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } },
    })).toEqual([{ requestId: "r1", type: "reasoning", text: "hmm" }]);
    const tool = eventsFromSessionUpdate("r1", {
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "call_1",
        name: "edit",
        title: "Edit note",
        status: "pending",
        content: [{ type: "diff", path: `${home}/note.md`, oldText: "a", newText: "b" }],
      },
    });
    expect(tool).toEqual([{ requestId: "r1", type: "tool", name: "edit", status: "pending", title: "Edit note" }]);
    expect(JSON.stringify(tool)).not.toContain(home);
    expect(eventsFromSessionUpdate("r1", {
      update: { sessionUpdate: "tool_call", toolCallId: "call_2", title: `${home}/secret`, status: "completed" },
    })).toEqual([{ requestId: "r1", type: "tool", name: "call_2", status: "completed" }]);
  });
});

// bun test started at the workspace root drops child stdin and stdout pipes
// (the bytes never arrive). The same processes work when cwd is apps/desktop,
// which is how `bun run test:desktop` runs this file.
const stdioPipesWork = await (async () => {
  const proc = Bun.spawn(["/bin/echo", "ok"], { stdout: "pipe", stderr: "ignore" });
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  return text.includes("ok");
})();
const sessionTest = stdioPipesWork ? test : test.skip;

describe("ACP stdio session", () => {
  const attachments = () => ([
    { filename: "/Users/me/secret.pdf", mediaType: "application/pdf", dataBase64: encode("%PDF-1.7") },
    { filename: "pic.png", mediaType: "image/png", dataBase64: encode("png-bytes") },
  ]);

  const readReport = async (reportPath) => JSON.parse(await readFile(reportPath, "utf8"));

  sessionTest("probes a session, then closes the process", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "edgeever-acp-probe-"));
    const reportPath = path.join(directory, "report.json");
    try {
      const scriptPath = await writeFakeAgent(directory, {
        reportPath,
        secretPath: path.join(directory, "secret.txt"),
        allowImage: true,
        allowEmbedded: true,
        hold: false,
      });
      const wrapper = path.join(directory, "wrap.sh");
      await writeFile(wrapper, `#!/bin/sh\necho RAN > ${JSON.stringify(path.join(directory, "ran.txt"))}\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)}\n`);
      await chmod(wrapper, 0o755);
      const { spawn } = await import("node:child_process");
      const spawned = [];
      const runtime = createAcpHostRuntime({
        spawnImpl(command, args, options) {
          spawned.push({ command, args, cwd: options.cwd, shell: options.shell });
          return spawn(command, args, options);
        },
      });
      const probed = await runtime.probeAdapter({ id: "antigravity", path: wrapper });
      expect(spawned[0]?.shell).toBe(false);
      expect(realpathSync(spawned[0]?.command)).toBe(realpathSync(wrapper));
      expect(probed.state).toBe("available");
      expect(probed.promptCapabilities).toEqual({ image: true, embeddedContext: true });
      const report = await readReport(reportPath);
      expect(report.initialize.clientCapabilities).toEqual({
        auth: { terminal: false },
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      });
      expect(path.resolve(report.newSession.cwd)).not.toBe(home);
      expect(report.newSession.cwd).toContain(`${path.sep}edgeever-acp-`);
      expect(report.newSession.mcpServers).toEqual([]);
      const pid = Number(await readFile(`${reportPath}.pid`, "utf8"));
      await waitUntilExited(pid);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);

  sessionTest("streams updates, cancels permission, and never reads a local file", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "edgeever-acp-prompt-"));
    const reportPath = path.join(directory, "report.json");
    const secretPath = path.join(directory, "secret.txt");
    await writeFile(secretPath, "SENTINEL_SECRET_CONTENT");
    try {
      const scriptPath = await writeFakeAgent(directory, {
        reportPath,
        secretPath,
        allowImage: true,
        allowEmbedded: true,
        hold: false,
      });
      const runtime = createAcpHostRuntime();
      const events = collector();
      const result = await runtime.prompt({
        adapterId: "antigravity",
        path: scriptPath,
        prompt: "hello",
        contextText: "context",
        attachments: attachments(),
      }, events.emit);
      await events.waitFor((event) => event.type === "done");
      const report = await readReport(reportPath);
      expect(report.permission?.outcome?.outcome).toBe("cancelled");
      expect(report.readResult).toBeNull();
      expect(JSON.stringify(report)).not.toContain("SENTINEL_SECRET_CONTENT");
      expect(path.resolve(report.newSession.cwd)).not.toBe(home);
      const serialized = JSON.stringify(report.prompt);
      expect(serialized).not.toContain("/Users/me/secret.pdf");
      expect(serialized).not.toContain(secretPath);
      expect(serialized).not.toContain("resource_link");
      expect(report.prompt.some((block) => block.type === "image" && block.mimeType === "image/png")).toBe(true);
      expect(report.prompt.some((block) => block.type === "resource" && String(block.resource?.uri).startsWith("edgeever-attachment:"))).toBe(true);
      expect(events.events).toContainEqual({ requestId: result.requestId, type: "reasoning", text: "thinking" });
      expect(events.events).toContainEqual({ requestId: result.requestId, type: "text-delta", text: "hello from agent" });
      expect(events.events).toContainEqual({
        requestId: result.requestId,
        type: "tool",
        name: "search",
        status: "pending",
        title: "Search notes",
      });
      expect(events.events.at(-1)).toEqual({ requestId: result.requestId, type: "done" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);

  sessionTest("drops image and PDF blocks when the agent does not advertise them", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "edgeever-acp-omit-"));
    const reportPath = path.join(directory, "report.json");
    try {
      const scriptPath = await writeFakeAgent(directory, {
        reportPath,
        secretPath: path.join(directory, "secret.txt"),
        allowImage: false,
        allowEmbedded: false,
        hold: false,
      });
      const runtime = createAcpHostRuntime();
      const events = collector();
      const result = await runtime.prompt({
        adapterId: "antigravity",
        path: scriptPath,
        prompt: "hello",
        attachments: attachments(),
      }, events.emit);
      expect(result.rejectedAttachments?.map((item) => item.reason)).toEqual([
        "This agent does not accept embedded files.",
        "This agent does not accept images.",
      ]);
      await events.waitFor((event) => event.type === "done");
      const report = await readReport(reportPath);
      expect(report.prompt.every((block) => block.type === "text")).toBe(true);
      expect(JSON.stringify(report.prompt)).not.toContain("/Users/me");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);

  sessionTest("cancels an in-flight prompt and ignores unknown ids", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "edgeever-acp-cancel-"));
    const reportPath = path.join(directory, "report.json");
    try {
      const scriptPath = await writeFakeAgent(directory, {
        reportPath,
        secretPath: path.join(directory, "secret.txt"),
        allowImage: false,
        allowEmbedded: false,
        hold: true,
      });
      const runtime = createAcpHostRuntime();
      const events = collector();
      const result = await runtime.prompt({
        adapterId: "antigravity",
        path: scriptPath,
        prompt: "wait",
      }, events.emit);
      await events.waitFor((event) => event.type === "text-delta");
      expect(await runtime.cancel(result.requestId)).toEqual({ ok: true });
      expect(await runtime.cancel("missing-request")).toEqual({ ok: true });
      await events.waitFor((event) => event.type === "done" || event.type === "error");
      const pid = Number(await readFile(`${reportPath}.pid`, "utf8"));
      await waitUntilExited(pid);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);
});

test("desktop preload and main process expose the ACP host", async () => {
  const [main, preload, host] = await Promise.all([
    Bun.file(new URL("./index.mjs", import.meta.url)).text(),
    Bun.file(new URL("../preload/index.cjs", import.meta.url)).text(),
    Bun.file(new URL("./acp-host.mjs", import.meta.url)).text(),
  ]);
  expect(main).toContain("registerAcpIpc(ipcMain)");
  expect(host).toContain('ipcMain.handle("desktop:acp-prompt"');
  expect(preload).toContain('listAcpAdapters: () => ipcRenderer.invoke("desktop:acp-list")');
  expect(preload).toContain('probeAcpAdapter: (input) => ipcRenderer.invoke("desktop:acp-probe", input)');
  expect(preload).toContain('promptAcp: (input) => ipcRenderer.invoke("desktop:acp-prompt", input)');
  expect(preload).toContain('cancelAcp: (requestId) => ipcRenderer.invoke("desktop:acp-cancel", requestId)');
  expect(preload).toContain('ipcRenderer.on("desktop:acp-event"');
  const handlers = new Map();
  registerAcpIpc({ handle: (channel, handler) => handlers.set(channel, handler) });
  expect([...handlers.keys()]).toEqual(["desktop:acp-list", "desktop:acp-probe", "desktop:acp-prompt", "desktop:acp-cancel"]);
});
