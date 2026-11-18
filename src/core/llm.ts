import { tmpdir } from "node:os";

import Anthropic from "@anthropic-ai/sdk";
import { AnthropicClient } from "@anvia/anthropic";
import { generateCompletion } from "@anvia/core/completion";
import { OpenAIClient } from "@anvia/openai";

import { getLlm } from "./settings";

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

const REQUEST_TIMEOUT_MS = 120_000;
/** A headless coding-agent CLI starts a whole session per call, so it gets more time than an API call. */
const COMMAND_TIMEOUT_MS = 300_000;
const BODY_EXCERPT = 300;
/**
 * Output budget of one endpoint call. Anvia's Anthropic client defaults to 1024 tokens, which cuts an AI edit
 * (a dozen timeline items with Indonesian text) or a long highlight list mid-JSON. 8192 fits every current model.
 */
const MAX_OUTPUT_TOKENS = 8192;

/** The model stopped at the output limit: the JSON is incomplete, and asking again gives the same cut. */
export class LlmTruncatedError extends Error {
  override name = "LlmTruncatedError";
}

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
  const { command } = getLlm();
  const timeout = AbortSignal.timeout(COMMAND_TIMEOUT_MS);
  const stop = signal ? AbortSignal.any([signal, timeout]) : timeout;
  stop.throwIfAborted();
  // POSIX: own process group, since a compound command (`a | b`, `cd x && cli`) leaves grandchildren
  // holding the stdout pipe, so stopping must kill the whole group, not just `sh`.
  // Windows: cmd.exe gets the command verbatim (`/s` strips the outer quotes) and `taskkill /T` kills the tree.
  const windows = process.platform === "win32";
  const proc = Bun.spawn(windows ? ["cmd.exe", "/d", "/s", "/c", `"${command}"`] : ["sh", "-c", command], {
    cwd: tmpdir(),
    stdin: new Blob([messages.map((message) => message.content).join("\n\n")]),
    stdout: "pipe",
    stderr: "pipe",
    ...(windows ? { windowsVerbatimArguments: true, windowsHide: true } : { detached: true }),
  });
  const killGroup = () => {
    if (windows) {
      Bun.spawn(["taskkill", "/T", "/F", "/PID", String(proc.pid)], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      return;
    }
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
 * Ask the configured model for a JSON answer: through the AI app command (LLM_COMMAND or a settings preset) when
 * one is chosen, otherwise through the OpenAI/Claude-compatible endpoint. A malformed answer (seen in practice: an
 * unescaped quote in a title) is asked for once more. Throws on transport errors and on a second unparsable answer.
 */
export async function chatJson(messages: ChatMessage[], signal?: AbortSignal): Promise<unknown> {
  const ask = getLlm().command ? askCommand : askEndpoint;
  try {
    return parseJsonAnswer(await ask(messages, signal));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return parseJsonAnswer(await ask(messages, signal));
  }
}

/** Ask through Anvia: an OpenAI-compatible (Chat Completions) or Anthropic-compatible (Messages) API. */
async function askEndpoint(messages: ChatMessage[], signal?: AbortSignal): Promise<string> {
  const llm = getLlm();
  if ((llm.mode !== "openai" && llm.mode !== "anthropic") || !llm.model)
    throw new Error("The highlight AI is not set up: open Settings and choose a model");
  // The SDKs refuse an empty key; local servers (Ollama, LM Studio) ignore whatever is sent.
  const client = { apiKey: llm.apiKey || "none", ...(llm.baseUrl ? { baseUrl: llm.baseUrl } : {}) };
  const request = {
    instructions: messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n\n"),
    prompt: messages
      .filter((message) => message.role === "user")
      .map((message) => message.content)
      .join("\n\n"),
    abortSignal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
      : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    maxTokens: MAX_OUTPUT_TOKENS,
  };
  const complete = async (model: Parameters<typeof generateCompletion>[0]["model"]): Promise<string> => {
    const result = await generateCompletion({ ...request, model });
    if (result.finishReason === "length")
      throw new LlmTruncatedError(`The AI answer was cut off at the ${MAX_OUTPUT_TOKENS}-token output limit`);
    return result.text;
  };
  try {
    if (llm.provider === "anthropic") {
      // The Anthropic SDK sends the key as `Authorization: Bearer`. Claude-compatible gateways
      // commonly check `x-api-key` instead, so a custom base URL gets both headers.
      const anthropic = llm.baseUrl
        ? new AnthropicClient({
            client: new Anthropic({
              apiKey: client.apiKey,
              baseURL: llm.baseUrl,
              maxRetries: 0,
              defaultHeaders: { "x-api-key": client.apiKey },
            }),
          })
        : new AnthropicClient(client);
      return await complete(anthropic.completionModel({ modelId: llm.model }));
    }
    return await complete(new OpenAIClient(client).completionModel({ modelId: llm.model, api: "chat" }));
  } catch (error) {
    if (error instanceof LlmTruncatedError) throw error;
    if (signal?.aborted) throw error;
    if (request.abortSignal.aborted)
      throw new Error(`LLM request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`, { cause: error });
    const message = error instanceof Error ? error.message : String(error);
    // An error body can echo the request; the key must never reach the UI or project warnings.
    throw new Error(
      `LLM request failed: ${(llm.apiKey.length >= 4 ? message.replaceAll(llm.apiKey, "***") : message).slice(0, BODY_EXCERPT)}`,
      { cause: error },
    );
  }
}

const TEST_TIMEOUT_MS = 60_000;

/** One tiny real request through the configured transport, for the Settings "Test" button. Never throws. */
export async function testLlm(): Promise<{ ok: boolean; ms: number; error?: string }> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  if (getLlm().mode === "off")
    return { ok: false, ms: 0, error: "Highlight AI is off. Choose an option and save first." };
  const signal = AbortSignal.timeout(TEST_TIMEOUT_MS);
  try {
    const answer = await chatJson(
      [
        { role: "system", content: "You are a connectivity check. Answer with JSON only." },
        { role: "user", content: 'Reply with exactly this JSON and nothing else: {"ok":true}' },
      ],
      signal,
    );
    if (typeof answer === "object" && answer !== null && "ok" in answer && answer.ok === true)
      return { ok: true, ms: elapsed() };
    return {
      ok: false,
      ms: elapsed(),
      error: `The AI answered, but not with the expected JSON: ${JSON.stringify(answer).slice(0, BODY_EXCERPT)}`,
    };
  } catch (error) {
    if (signal.aborted) return { ok: false, ms: elapsed(), error: `No answer after ${TEST_TIMEOUT_MS / 1000}s` };
    return { ok: false, ms: elapsed(), error: error instanceof Error ? error.message : String(error) };
  }
}
