// Tests must exercise the built-in heuristics, never a model configured in the developer's .env.
delete Bun.env.LLM_COMMAND;
delete Bun.env.LLM_BASE_URL;
delete Bun.env.LLM_MODEL;
delete Bun.env.LLM_API_KEY;
