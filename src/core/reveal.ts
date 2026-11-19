import { stat } from "node:fs/promises";
import { dirname } from "node:path";

import { NotFoundError } from "./store";

/**
 * Shows a file in the system file manager: selected in Finder (macOS) or Explorer (Windows); on Linux the
 * containing folder opens (there is no portable "select this file"). Directories open as themselves.
 * Returns once the file manager has been launched; it is not waited for.
 */
export async function revealInFileManager(path: string): Promise<void> {
  const info = await stat(path).catch(() => null);
  if (!info) throw new NotFoundError(`Not found: ${path}`);
  const command =
    process.platform === "darwin"
      ? ["open", ...(info.isDirectory() ? [] : ["-R"]), path]
      : process.platform === "win32"
        ? // `/select,` takes the path glued to it; explorer.exe exits with 1 even on success, so the code is ignored.
          ["explorer.exe", info.isDirectory() ? path : `/select,${path}`]
        : ["xdg-open", info.isDirectory() ? path : dirname(path)];
  const proc = Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  proc.unref();
}
