import { readFileSync } from "node:fs";
import { chmod, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { MAX_RENDER_JOBS } from "../shared/settings";
import { WORKSPACE_DIR, whisperModelFile } from "./config";
import { ConflictError, ValidationError } from "./store";

/**
 * User settings edited in the web UI, persisted in <workspace>/settings.json.
 * Precedence per field: environment variable (including .env) > settings.json > built-in default.
 * Getters read at call time, so a saved change applies without a restart.
 */

export const AI_MODES = ["off", "command", "openai", "anthropic"] as const;
export type AiMode = (typeof AI_MODES)[number];

/**
 * Apps the user can pick instead of typing a command: `llm.ts` runs the command through a shell, so a free-text
 * command stored in settings (or accepted by the API) would turn any request that reaches the server into
 * command execution. A custom command stays possible only through the LLM_COMMAND environment variable.
 */
export const AI_COMMAND_PRESETS = {
  claude: { label: "Claude Code", binary: "claude", command: 'claude -p --tools ""' },
  // `codex exec -` reads the prompt from stdin and prints the final answer on stdout.
  codex: {
    label: "Codex",
    binary: "codex",
    command: "codex exec --skip-git-repo-check --sandbox read-only --ephemeral -",
  },
} as const;
export type AiCommandPreset = keyof typeof AI_COMMAND_PRESETS;

export interface WhisperModelInfo {
  name: string;
  /** Download size in bytes (Hugging Face `ggerganov/whisper.cpp`). */
  size: number;
}

/** Every model has a DTW alignment preset in transcribe.ts (word timestamps need one). */
export const WHISPER_MODELS: WhisperModelInfo[] = [
  { name: "tiny", size: 77_691_713 },
  { name: "tiny-q5_1", size: 32_152_673 },
  { name: "tiny-q8_0", size: 43_537_433 },
  { name: "base", size: 147_951_465 },
  { name: "base-q5_1", size: 59_707_625 },
  { name: "base-q8_0", size: 81_768_585 },
  { name: "small", size: 487_601_967 },
  { name: "small-q5_1", size: 190_085_487 },
  { name: "small-q8_0", size: 264_464_607 },
  { name: "medium", size: 1_533_763_059 },
  { name: "medium-q5_0", size: 539_212_467 },
  { name: "medium-q8_0", size: 823_369_779 },
  { name: "large-v3", size: 3_095_033_483 },
  { name: "large-v3-q5_0", size: 1_081_140_203 },
  { name: "large-v3-turbo", size: 1_624_555_275 },
  { name: "large-v3-turbo-q5_0", size: 574_041_195 },
  { name: "large-v3-turbo-q8_0", size: 874_188_075 },
];

/** A model counts as installed once its file exists and is not empty (downloads land via `.part` + rename). */
export async function whisperModelInstalled(name: string): Promise<boolean> {
  const info = await stat(whisperModelFile(name).path).catch(() => null);
  return Boolean(info?.isFile() && info.size > 0);
}

export const DEFAULT_WHISPER_MODEL = "large-v3-turbo-q5_0";
const DEFAULT_RENDER_JOBS = 2;

export const SETTING_FIELDS = [
  "aiMode",
  "llmCommandPreset",
  "llmModel",
  "llmBaseUrl",
  "llmApiKey",
  "whisperModel",
  "defaultLanguage",
  "renderJobs",
] as const;
export type SettingField = (typeof SETTING_FIELDS)[number];

export interface SettingValues {
  aiMode: AiMode;
  llmCommandPreset: AiCommandPreset | null;
  llmModel: string;
  llmBaseUrl: string;
  llmApiKey: string;
  whisperModel: string;
  defaultLanguage: string;
  renderJobs: number;
}

export type SettingSource = "env" | "settings" | "default";

export interface EffectiveSettings {
  values: SettingValues;
  sources: Record<SettingField, SettingSource>;
  /** Environment variable that decides the field, for fields whose source is "env". */
  envVars: Partial<Record<SettingField, string>>;
}

const DEFAULTS: SettingValues = {
  aiMode: "off",
  llmCommandPreset: null,
  llmModel: "",
  llmBaseUrl: "",
  llmApiKey: "",
  whisperModel: DEFAULT_WHISPER_MODEL,
  defaultLanguage: "auto",
  renderJobs: DEFAULT_RENDER_JOBS,
};

export const settingsPath = () => join(WORKSPACE_DIR, "settings.json");

const LANGUAGE_PATTERN = /^(auto|[a-z]{2,3})$/;
const MAX_TEXT = 300;

function isAiMode(value: unknown): value is AiMode {
  return typeof value === "string" && (AI_MODES as readonly string[]).includes(value);
}

function isPreset(value: unknown): value is AiCommandPreset {
  return typeof value === "string" && Object.hasOwn(AI_COMMAND_PRESETS, value);
}

function text(value: unknown, field: string, max = MAX_TEXT): string {
  if (typeof value !== "string") throw new ValidationError(`${field} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new ValidationError(`${field} must be at most ${max} characters`);
  return trimmed;
}

function baseUrl(value: unknown): string {
  const raw = text(value, "llmBaseUrl", 500);
  if (raw === "") return "";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ValidationError("llmBaseUrl must be a full web address such as https://api.example.com/v1");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new ValidationError("llmBaseUrl must start with http:// or https://");
  if (url.username || url.password)
    throw new ValidationError("llmBaseUrl must not contain a user name or password; use the API key field");
  return raw.replace(/\/+$/, "");
}

/** Validates one field value (from the API or from the file); the file and the API share the rules. */
function parseField<F extends SettingField>(field: F, value: unknown): SettingValues[F];
function parseField(field: SettingField, value: unknown): SettingValues[SettingField] {
  switch (field) {
    case "aiMode":
      if (!isAiMode(value)) throw new ValidationError(`aiMode must be one of ${AI_MODES.join(", ")}`);
      return value;
    case "llmCommandPreset":
      if (value !== null && !isPreset(value)) {
        throw new ValidationError(
          `llmCommandPreset must be null or one of ${Object.keys(AI_COMMAND_PRESETS).join(", ")}`,
        );
      }
      return value;
    case "llmModel":
      return text(value, field);
    case "llmBaseUrl":
      return baseUrl(value);
    case "llmApiKey":
      if (typeof value !== "string") throw new ValidationError("llmApiKey must be a string");
      if (value.length > 500 || /[\r\n]/.test(value))
        throw new ValidationError("llmApiKey must be a single line of at most 500 characters");
      return value.trim();
    case "whisperModel": {
      if (typeof value !== "string" || !WHISPER_MODELS.some((model) => model.name === value)) {
        throw new ValidationError(
          `whisperModel must be one of ${WHISPER_MODELS.map((model) => model.name).join(", ")}`,
        );
      }
      return value;
    }
    case "defaultLanguage":
      if (typeof value !== "string" || !LANGUAGE_PATTERN.test(value)) {
        throw new ValidationError(`defaultLanguage must be "auto" or a language code like "en"`);
      }
      return value;
    case "renderJobs":
      if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_RENDER_JOBS) {
        throw new ValidationError(`renderJobs must be a whole number from 1 to ${MAX_RENDER_JOBS}`);
      }
      return value;
  }
}

type StoredSettings = Partial<Record<SettingField, unknown>>;

function readStored(): StoredSettings {
  let raw: string;
  try {
    raw = readFileSync(settingsPath(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`${settingsPath()} is not valid JSON. Fix it or delete the file to reset your settings.`);
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error(`${settingsPath()} must contain a JSON object. Fix it or delete the file to reset your settings.`);
  }
  const stored: StoredSettings = {};
  for (const field of SETTING_FIELDS) {
    const value = (data as Record<string, unknown>)[field];
    if (value === undefined) continue;
    try {
      stored[field] = parseField(field, value);
    } catch (error) {
      throw new Error(
        `${settingsPath()}: ${error instanceof Error ? error.message : String(error)}. Fix it or delete the file.`,
        { cause: error },
      );
    }
  }
  return stored;
}

const envText = (name: string): string => Bun.env[name]?.trim() ?? "";

/** Environment variable that decides the AI mode, or null when the mode comes from settings. */
function aiModeEnv(): { mode: AiMode; envVar: string } | null {
  if (envText("LLM_COMMAND")) return { mode: "command", envVar: "LLM_COMMAND" };
  if (envText("LLM_MODEL"))
    return { mode: envText("LLM_PROVIDER") === "anthropic" ? "anthropic" : "openai", envVar: "LLM_MODEL" };
  return null;
}

/** The environment variable that locks a field, when it is set. */
function lockingEnv(field: SettingField): string | null {
  switch (field) {
    case "aiMode":
      return aiModeEnv()?.envVar ?? null;
    case "llmCommandPreset":
      return envText("LLM_COMMAND") ? "LLM_COMMAND" : null;
    case "llmModel":
      return envText("LLM_MODEL") ? "LLM_MODEL" : null;
    case "llmBaseUrl":
      return envText("LLM_BASE_URL") ? "LLM_BASE_URL" : null;
    case "llmApiKey":
      return envText("LLM_API_KEY") ? "LLM_API_KEY" : null;
    case "whisperModel":
      return envText("WHISPER_MODEL") ? "WHISPER_MODEL" : null;
    case "renderJobs":
      return Number(envText("GCLIP_RENDER_JOBS")) >= 1 ? "GCLIP_RENDER_JOBS" : null;
    case "defaultLanguage":
      return null;
  }
}

function resolve(stored: StoredSettings): EffectiveSettings {
  const values = { ...DEFAULTS } as Record<SettingField, unknown>;
  const sources = {} as Record<SettingField, SettingSource>;
  const envVars: Partial<Record<SettingField, string>> = {};
  const envValues: Partial<Record<SettingField, unknown>> = {
    aiMode: aiModeEnv()?.mode,
    llmCommandPreset: null,
    llmModel: envText("LLM_MODEL"),
    llmBaseUrl: envText("LLM_BASE_URL").replace(/\/+$/, ""),
    llmApiKey: envText("LLM_API_KEY"),
    whisperModel: envText("WHISPER_MODEL"),
    renderJobs: Math.floor(Number(envText("GCLIP_RENDER_JOBS"))),
  };
  for (const field of SETTING_FIELDS) {
    const envVar = lockingEnv(field);
    if (envVar) {
      values[field] = envValues[field];
      sources[field] = "env";
      envVars[field] = envVar;
    } else if (stored[field] !== undefined) {
      values[field] = stored[field];
      sources[field] = "settings";
    } else {
      sources[field] = "default";
    }
  }
  return { values: values as unknown as SettingValues, sources, envVars };
}

/** Effective settings right now (reads settings.json and the environment on every call). */
export function getSettings(): EffectiveSettings {
  return resolve(readStored());
}

export interface LlmConfig {
  mode: AiMode;
  /** Shell command for mode "command": LLM_COMMAND or the chosen preset's fixed command. */
  command: string;
  provider: "openai" | "anthropic";
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** What `llm.ts` needs, resolved at call time. */
export function getLlm(): LlmConfig {
  const { values } = getSettings();
  let command = "";
  if (values.aiMode === "command") {
    command =
      envText("LLM_COMMAND") || (values.llmCommandPreset ? AI_COMMAND_PRESETS[values.llmCommandPreset].command : "");
  }
  return {
    mode: values.aiMode,
    command,
    provider: values.aiMode === "anthropic" ? "anthropic" : "openai",
    baseUrl: values.llmBaseUrl,
    apiKey: values.llmApiKey,
    model: values.llmModel,
  };
}

export function llmConfigured(): boolean {
  return getSettings().values.aiMode !== "off";
}

/** Rules that span fields, checked on the merged result of a change. */
function checkCombination(values: SettingValues, hasEnvCommand: boolean): void {
  if (values.aiMode === "command" && !hasEnvCommand && values.llmCommandPreset === null) {
    throw new ValidationError("Choose which AI app to use (llmCommandPreset)");
  }
  if ((values.aiMode === "openai" || values.aiMode === "anthropic") && values.llmModel === "") {
    throw new ValidationError("Enter a model name (llmModel) to use an API");
  }
}

/**
 * Applies a partial change and persists it. All-or-nothing: throws ValidationError (400) for a bad field or
 * unknown key and ConflictError (409) for a field an environment variable decides; nothing is written then.
 * `llmApiKey: ""`, `llmModel: ""` and `llmBaseUrl: ""` clear the saved value.
 */
export async function updateSettings(patch: Record<string, unknown>): Promise<void> {
  const changes: StoredSettings = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!(SETTING_FIELDS as readonly string[]).includes(key)) {
      throw new ValidationError(`Unknown setting "${key}" (allowed: ${SETTING_FIELDS.join(", ")})`);
    }
    const field = key as SettingField;
    changes[field] = parseField(field, value);
  }
  for (const field of Object.keys(changes) as SettingField[]) {
    const envVar = lockingEnv(field);
    if (envVar)
      throw new ConflictError(
        `"${field}" is set by ${envVar} in your environment or .env file. Remove it there to change it here.`,
      );
  }
  if (typeof changes.whisperModel === "string" && !(await whisperModelInstalled(changes.whisperModel))) {
    throw new ValidationError(`Download the "${changes.whisperModel}" model first, then select it`);
  }

  const stored = { ...readStored(), ...changes };
  for (const field of SETTING_FIELDS) {
    if (stored[field] === "" || (field === "llmCommandPreset" && stored[field] === null)) delete stored[field];
  }
  checkCombination(resolve(stored).values, Boolean(envText("LLM_COMMAND")));

  const file = settingsPath();
  await mkdir(WORKSPACE_DIR, { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  try {
    // 0600: the file can hold an API key. The mode is applied again after the write because umask only ever removes bits.
    await writeFile(temp, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
    if (process.platform !== "win32") await chmod(temp, 0o600);
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

export interface PublicSettings {
  values: Omit<SettingValues, "llmApiKey">;
  /** The API key is never returned. */
  llmApiKeySet: boolean;
  sources: Record<SettingField, SettingSource>;
  envVars: Partial<Record<SettingField, string>>;
  aiCommandPresets: { id: AiCommandPreset; label: string; command: string; found: boolean }[];
}

export function publicSettings(): PublicSettings {
  const { values, sources, envVars } = getSettings();
  const { llmApiKey, ...rest } = values;
  return {
    values: rest,
    llmApiKeySet: llmApiKey !== "",
    sources,
    envVars,
    aiCommandPresets: (Object.keys(AI_COMMAND_PRESETS) as AiCommandPreset[]).map((id) => ({
      id,
      label: AI_COMMAND_PRESETS[id].label,
      command: AI_COMMAND_PRESETS[id].command,
      found: Bun.which(AI_COMMAND_PRESETS[id].binary) !== null,
    })),
  };
}
