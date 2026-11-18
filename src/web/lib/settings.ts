import type { AiCommandPreset, AiMode, PublicSettings, SettingValues } from "../../core/settings";

export type { AiCommandPreset, AiMode };

export interface SettingsInfo {
  port: number;
  host: string;
  workspace: string;
  models: string;
  version: string;
}

export type SettingsResponse = PublicSettings & { info: SettingsInfo };
export type SettingsPatch = Partial<SettingValues>;

/** What the dialog edits. `apiKey` is only what the user typed: the saved key never reaches the browser. */
export interface Draft {
  aiMode: AiMode;
  llmCommandPreset: AiCommandPreset | null;
  llmModel: string;
  llmBaseUrl: string;
  apiKey: string;
  clearApiKey: boolean;
  whisperModel: string;
  defaultLanguage: string;
  renderJobs: number;
  /** The guidance text as shown in the editor: the saved prompt, or the built-in default when none is saved. */
  highlightPrompt: string;
  socialPrompt: string;
}

export function draftFrom(settings: SettingsResponse): Draft {
  const { values } = settings;
  return {
    aiMode: values.aiMode,
    llmCommandPreset: values.llmCommandPreset,
    llmModel: values.llmModel,
    llmBaseUrl: values.llmBaseUrl,
    apiKey: "",
    clearApiKey: false,
    whisperModel: values.whisperModel,
    defaultLanguage: values.defaultLanguage,
    renderJobs: values.renderJobs,
    highlightPrompt: values.highlightPrompt || settings.defaults.highlightPrompt,
    socialPrompt: values.socialPrompt || settings.defaults.socialPrompt,
  };
}

/** Only the fields that changed and that no environment variable decides. */
export function buildPatch(draft: Draft, settings: SettingsResponse): SettingsPatch {
  const { values, sources } = settings;
  const patch: SettingsPatch = {};
  const free = (field: keyof SettingValues) => sources[field] !== "env";
  if (free("aiMode") && draft.aiMode !== values.aiMode) patch.aiMode = draft.aiMode;
  if (free("llmCommandPreset") && draft.llmCommandPreset !== values.llmCommandPreset)
    patch.llmCommandPreset = draft.llmCommandPreset;
  if (free("llmModel") && draft.llmModel.trim() !== values.llmModel) patch.llmModel = draft.llmModel;
  if (free("llmBaseUrl") && draft.llmBaseUrl.trim().replace(/\/+$/, "") !== values.llmBaseUrl)
    patch.llmBaseUrl = draft.llmBaseUrl;
  if (free("llmApiKey")) {
    if (draft.apiKey !== "") patch.llmApiKey = draft.apiKey;
    else if (draft.clearApiKey) patch.llmApiKey = "";
  }
  if (free("whisperModel") && draft.whisperModel !== values.whisperModel) patch.whisperModel = draft.whisperModel;
  if (free("defaultLanguage") && draft.defaultLanguage !== values.defaultLanguage)
    patch.defaultLanguage = draft.defaultLanguage;
  if (free("renderJobs") && draft.renderJobs !== values.renderJobs) patch.renderJobs = draft.renderJobs;
  for (const field of ["highlightPrompt", "socialPrompt"] as const) {
    const fallback = settings.defaults[field];
    if (draft[field].trim() === (values[field] || fallback).trim()) continue;
    // Text equal to the built-in default is saved as "" so a later improvement of the default reaches the user.
    patch[field] = draft[field].trim() === fallback.trim() ? "" : draft[field];
  }
  return patch;
}

export function fmtBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  return `${Math.round(bytes / 1e6)} MB`;
}
