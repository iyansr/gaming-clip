import { mkdir, rename, stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { BIN, MODELS } from "../src/core/config";
import { BINARY_FORMULAS, checkDeps, type DepStatus } from "../src/core/doctor";
import { run } from "../src/core/exec";

function printReport(statuses: DepStatus[]): void {
  for (const status of statuses) {
    const mark = status.ok ? "OK  " : "MISS";
    const hint = status.ok || !status.fix ? "" : `  -> ${status.fix}`;
    console.log(`${mark} ${status.name.padEnd(36)} ${status.detail}${hint}`);
  }
}

async function downloadModel(name: string, url: string, path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const part = `${path}.part`;
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status} for ${url}`);
  const total = Number(response.headers.get("content-length") ?? 0);
  let received = 0;
  let reported = -1;
  const writer = Bun.file(part).writer();
  try {
    for await (const chunk of response.body) {
      await writer.write(chunk);
      received += chunk.byteLength;
      if (total > 0) {
        const percent = Math.floor((received / total) * 100);
        if (percent !== reported) {
          reported = percent;
          await writer.flush();
          process.stdout.write(`\r${name}: ${percent}% (${(received / 1024 / 1024).toFixed(1)} MB)`);
        }
      }
    }
  } finally {
    await writer.end();
  }
  process.stdout.write("\n");
  const info = await stat(part).catch(() => null);
  if (!info || info.size === 0) throw new Error(`Download of ${name} produced no data`);
  if (total > 0 && info.size !== total) throw new Error(`Download of ${name} incomplete (${info.size}/${total} bytes)`);
  await rename(part, path);
}

async function main(): Promise<void> {
  let statuses = await checkDeps();
  printReport(statuses);

  const missingBins = [...new Set(statuses.filter((s) => !s.ok && s.name in BINARY_FORMULAS).map((s) => s.name))];
  const brew = Bun.which("brew");
  if (missingBins.length > 0) {
    if (process.platform === "darwin" && brew) {
      const formulas = [...new Set(missingBins.map((name) => BINARY_FORMULAS[name]).filter((f): f is string => Boolean(f)))];
      console.log(`\nInstalling with Homebrew: ${formulas.join(" ")}`);
      await run(brew, ["install", ...formulas]);
    } else {
      for (const name of missingBins) console.log(`\nInstall ${name}: ${statuses.find((s) => s.name === name)?.fix}`);
    }
  }

  for (const model of Object.values(MODELS)) {
    const name = basename(model.path);
    if (statuses.find((status) => status.name === name)?.ok) continue;
    console.log(`\nDownloading ${name}`);
    await downloadModel(name, model.url, model.path);
  }

  statuses = await checkDeps();
  const failed = statuses.filter((status) => !status.ok);
  if (failed.length > 0) {
    console.log();
    printReport(statuses);
    console.error(`\n${failed.length} dependency check(s) failed. Fix them and run \`bun run setup\` again.`);
    process.exit(1);
  }
  console.log(`\nAll dependencies ready. Binaries: ${BIN.ffmpeg}, ${BIN.ytDlp}, ${BIN.whisper}`);
}

await main();
