export interface RunOptions {
  cwd?: string;
  signal?: AbortSignal;
  /** Called per stdout line (split on \n and \r, so carriage-return progress lines arrive too). */
  onStdout?: (line: string) => void;
  onStderr?: (line: string) => void;
}

export interface RunResult {
  stdout: string;
  /** Last ~16 KB of stderr. */
  stderr: string;
}

export class ExecError extends Error {
  constructor(
    readonly command: string,
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    const tail = stderr.trim().split("\n").slice(-6).join("\n");
    super(`${command} exited with code ${exitCode}${tail ? `:\n${tail}` : ""}`);
    this.name = "ExecError";
  }
}

const STDERR_TAIL = 16 * 1024;

async function pump(
  stream: ReadableStream<Uint8Array>,
  onLine: ((line: string) => void) | undefined,
  keep: "all" | "tail",
): Promise<string> {
  const decoder = new TextDecoder();
  let kept = "";
  let pending = "";
  for await (const chunk of stream) {
    const text = decoder.decode(chunk, { stream: true });
    kept += text;
    if (keep === "tail" && kept.length > STDERR_TAIL * 2) kept = kept.slice(-STDERR_TAIL);
    if (!onLine) continue;
    pending += text;
    const lines = pending.split(/[\r\n]+/);
    pending = lines.pop() ?? "";
    for (const line of lines) if (line) onLine(line);
  }
  if (onLine && pending) onLine(pending);
  return keep === "tail" ? kept.slice(-STDERR_TAIL) : kept;
}

/**
 * Run a binary to completion. Rejects with ExecError on a non-zero exit and with the
 * signal's abort reason when aborted (the child is killed).
 */
export async function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  opts.signal?.throwIfAborted();
  const proc = Bun.spawn([cmd, ...args], {
    cwd: opts.cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const onAbort = () => proc.kill();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      pump(proc.stdout, opts.onStdout, "all"),
      pump(proc.stderr, opts.onStderr, "tail"),
      proc.exited,
    ]);
    opts.signal?.throwIfAborted();
    if (exitCode !== 0) throw new ExecError(cmd, exitCode, stderr);
    return { stdout, stderr };
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
  }
}
