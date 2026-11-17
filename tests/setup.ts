// Tests must exercise the built-in heuristics, never a model configured in the developer's .env.
delete process.env.LLM_COMMAND;
delete process.env.LLM_BASE_URL;
delete process.env.LLM_MODEL;
delete process.env.LLM_API_KEY;
