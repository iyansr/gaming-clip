import { tmpdir } from "node:os";
import Anthropic from "@anthropic-ai/sdk";
import { AnthropicClient } from "@anvia/anthropic";
import { generateCompletion } from "@anvia/core/completion";
import { OpenAIClient } from "@anvia/openai";
import { LLM } from "./config";

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

const REQUEST_TIMEOUT_MS = 120_000;
/** A headless coding-agent CLI starts a whole session per call, so it gets more time than an API call. */
const COMMAND_TIMEOUT_MS = 300_000;
const BODY_EXCERPT = 300;

/** Models wrap JSON in a code fence or a sentence of prose; take the fenced or outermost object. */
function parseJsonAnswer(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /```[a-zA-Z]*\s*\n?([\s\S]*?)\n?```/.exec(trimmed);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  try {
    return JSON.parse(candidate);
  } catch (error) {
    const open = candidate.indexOf("{");
    const close = candidate.lastIndexOf("}");
    if (open < 0 || close <= open) throw error;
    return JSON.parse(candidate.slice(open, close + 1));
  }
}

/**
 * Ask through LLM_COMMAND: the prompt goes to the command's stdin, its stdout is the answer.
 * Runs in the temp dir so a coding-agent CLI does not load this repository's instructions.
 */
async function askCommand(messages: ChatMessage[], signal?: AbortSignal): Promise<string> {
  const timeout = AbortSignal.timeout(COMMAND_TIMEOUT_MS);
  const stop = signal ? AbortSignal.any([signal, timeout]) : timeout;
  stop.throwIfAborted();
  // Own process group: a compound command (`a | b`, `cd x && cli`) leaves grandchildren holding
  // the stdout pipe, so stopping must kill the whole group, not just `sh`.
  const proc = Bun.spawn(["sh", "-c", LLM.command], {
    cwd: tmpdir(),
    stdin: new Blob([messages.map((message) => message.content).join("\n\n")]),
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
  const killGroup = () => {
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {
      // The group is already gone.
    }
  };
  stop.addEventListener("abort", killGroup, { once: true });
  let stdout: string;
  let stderr: string;
  let exitCode: number;
  try {
    [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
  } finally {
    stop.removeEventListener("abort", killGroup);
  }
  signal?.throwIfAborted();
  if (timeout.aborted) throw new Error(`LLM command timed out after ${COMMAND_TIMEOUT_MS / 1000}s`);
  if (exitCode !== 0) {
    const excerpt = (stderr.trim() || stdout.trim()).slice(-BODY_EXCERPT);
    throw new Error(`LLM command exited with code ${exitCode}${excerpt ? `: ${excerpt}` : ""}`);
  }
  if (stdout.trim() === "") throw new Error("LLM command printed nothing on stdout");
  return stdout;
}

/**
 * Ask the configured model for a JSON answer: through LLM_COMMAND when set, otherwise through
 * the OpenAI-compatible endpoint. A malformed answer (seen in practice: an unescaped quote in a
 * title) is asked for once more. Throws on transport errors and on a second unparsable answer.
 */
export async function chatJson(messages: ChatMessage[], signal?: AbortSignal): Promise<unknown> {
  const ask = LLM.command ? askCommand : askEndpoint;
  try {
    return parseJsonAnswer(await ask(messages, signal));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return parseJsonAnswer(await ask(messages, signal));
  }
}

/** Ask through Anvia: an OpenAI-compatible (Chat Completions) or Anthropic-compatible (Messages) API. */
async function askEndpoint(messages: ChatMessage[], signal?: AbortSignal): Promise<string> {
  if (!LLM.model) throw new Error("LLM is not configured (LLM_MODEL is required)");
  // The SDKs refuse an empty key; local servers (Ollama, LM Studio) ignore whatever is sent.
  const client = { apiKey: LLM.apiKey || "none", ...(LLM.baseUrl ? { baseUrl: LLM.baseUrl } : {}) };
  const request = {
    instructions: messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n"),
    prompt: messages.filter((message) => message.role === "user").map((message) => message.content).join("\n\n"),
    abortSignal: signal ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  };
  try {
    if (LLM.provider === "anthropic") {
      // The Anthropic SDK sends the key as `Authorization: Bearer`. Claude-compatible gateways
      // commonly check `x-api-key` instead, so a custom base URL gets both headers.
      const anthropic = LLM.baseUrl
        ? new AnthropicClient({
            client: new Anthropic({ apiKey: client.apiKey, baseURL: LLM.baseUrl, maxRetries: 0, defaultHeaders: { "x-api-key": client.apiKey } }),
          })
        : new AnthropicClient(client);
      return (await generateCompletion({ ...request, model: anthropic.completionModel({ modelId: LLM.model }) })).text;
    }
    if (LLM.provider === "openai") {
      return (await generateCompletion({ ...request, model: new OpenAIClient(client).completionModel({ modelId: LLM.model, api: "chat" }) })).text;
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    if (request.abortSignal.aborted) throw new Error(`LLM request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`LLM request failed: ${message.slice(0, BODY_EXCERPT)}`);
  }
  throw new Error(`Unknown LLM_PROVIDER "${LLM.provider}" (use "openai" or "anthropic")`);
}
