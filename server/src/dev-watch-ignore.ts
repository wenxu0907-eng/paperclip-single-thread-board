import fs from "node:fs";
import path from "node:path";

function toGlobstarPath(candidate: string): string {
  return `${candidate.replaceAll(path.sep, "/")}/**`;
}

function addIgnorePath(target: Set<string>, candidate: string): void {
  target.add(candidate);
  target.add(toGlobstarPath(candidate));
  try {
    const realPath = fs.realpathSync(candidate);
    target.add(realPath);
    target.add(toGlobstarPath(realPath));
  } catch {
    // Ignore paths that do not exist in the current checkout.
  }
}

export function resolveServerDevWatchIgnorePaths(serverRoot: string): string[] {
  const ignorePaths = new Set<string>([
    "**/{node_modules,bower_components,vendor}/**",
    "**/.vite-temp/**",
  ]);

  for (const relativePath of [
    "../ui/node_modules",
    "../ui/node_modules/.vite-temp",
    "../ui/.vite",
    "../ui/dist",
    // npm install during reinstall would trigger a restart mid-request
    // if tsx watch sees the new files. Exclude the managed plugins dir.
    process.env.HOME + "/.paperclip/adapter-plugins",
    // COM-145: installing/upgrading a reviewed plugin writes into
    // `~/.paperclip/plugins/node_modules/**/dist`. If tsx watch sees those
    // files it restarts the core server mid-deploy and kills the very run
    // performing the install (`error_code=process_lost`). Plugin dist changes
    // must hot-reload via `plugin-dev-watcher`, never restart the host process,
    // so exclude the managed runtime plugins dir (mirrors DEFAULT_LOCAL_PLUGIN_DIR).
    process.env.HOME + "/.paperclip/plugins",
  ]) {
    addIgnorePath(ignorePaths, path.resolve(serverRoot, relativePath));
  }

  return [...ignorePaths];
}
