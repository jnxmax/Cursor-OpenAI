import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Logger } from "../logger";

// Both src/cursor and dist/cursor are two levels below the repository root.
const routerPath = path.resolve(__dirname, "../../scripts/cursor-native-lifecycle-router.py");

function shellQuote(value: string): string {
  // Cursor hooks require a shell command string, not an argv array.
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function publishHook(hooksPath: string, content: string): void {
  const temporary = `${hooksPath}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, content, { flag: "wx", mode: 0o600 });
  try {
    // Linking publishes complete bytes atomically without overwriting a competing writer.
    fs.linkSync(temporary, hooksPath);
  } finally {
    fs.unlinkSync(temporary);
  }
}

export function installNativeLifecycleHook(params: Readonly<{ cwd: string; helper: string | undefined; log: Logger }>): boolean {
  const { cwd, helper, log } = params;
  if (!helper) return false;
  try {
    if (!path.isAbsolute(helper) || !fs.statSync(helper).isFile()) {
      throw new Error("Native restart helper must be an existing absolute file path");
    }
    if (!fs.statSync(routerPath).isFile()) throw new Error("Native lifecycle router is unavailable");
    const directory = path.join(cwd, ".cursor");
    fs.mkdirSync(directory, { recursive: true });
    if (!fs.lstatSync(directory).isDirectory()) throw new Error("Refusing a linked Cursor settings directory");
    const hooksPath = path.join(directory, "hooks.json");
    const content = JSON.stringify({
      version: 1,
      hooks: { preToolUse: [{
        command: `/usr/bin/python3 ${shellQuote(routerPath)} --helper ${shellQuote(helper)}`,
        timeout: 3,
        failClosed: false,
      }] },
    }, null, 2) + "\n";
    const existing = fs.lstatSync(hooksPath, { throwIfNoEntry: false });
    if (existing) {
      if (existing.isFile() && fs.readFileSync(hooksPath, "utf8") === content) return true;
      log.warn({ cwd }, "Foreign Cursor hooks preserved; native lifecycle project settings disabled");
      return false;
    }
    publishHook(hooksPath, content);
    return true;
  } catch (err) {
    log.warn({ err, cwd }, "Native lifecycle hook unavailable; project settings disabled");
    return false;
  }
}

// SDK local stores are workspace-scoped: resuming in a fresh directory loses the agent.
// This private alias contains no credential and never overwrites an existing path.
export function rememberNativeWorkspace(params: Readonly<{ cwd: string; alias: string; log: Logger }>): void {
  const { cwd, alias, log } = params;
  try {
    if (fs.lstatSync(alias, { throwIfNoEntry: false })) {
      if (fs.realpathSync(alias) !== cwd) throw new Error("Native workspace alias already owned");
      return;
    }
    fs.symlinkSync(path.basename(cwd), alias, "dir");
  } catch (err) {
    log.warn({ err, cwd }, "Native resume workspace could not be recorded");
  }
}

export function findNativeWorkspace(alias: string, log: Logger): string | undefined {
  try {
    const entry = fs.lstatSync(alias, { throwIfNoEntry: false });
    if (!entry) return undefined;
    if (!entry.isSymbolicLink()) throw new Error("Native workspace alias is not a link");
    const cwd = fs.realpathSync(alias);
    if (path.dirname(cwd) !== path.resolve(path.dirname(alias)) || !fs.statSync(cwd).isDirectory()) {
      throw new Error("Native workspace alias leaves the controlled root");
    }
    return cwd;
  } catch (err) {
    log.warn({ err }, "Native resume workspace unavailable; retaining SDK resume defaults");
    return undefined;
  }
}
