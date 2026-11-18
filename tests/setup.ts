import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Tests must exercise the built-in heuristics, never a model configured in the developer's .env ...
delete Bun.env.LLM_COMMAND;
delete Bun.env.LLM_BASE_URL;
delete Bun.env.LLM_MODEL;
delete Bun.env.LLM_API_KEY;

// ... or saved from the Settings dialog: settings.json lives in the workspace, so tests get their own.
// (Runs before any test file imports src/core/config.ts, which reads this variable once.)
const workspace = mkdtempSync(join(tmpdir(), "gclip-test-ws-"));
Bun.env.GCLIP_WORKSPACE = workspace;
process.on("exit", () => rmSync(workspace, { recursive: true, force: true }));
