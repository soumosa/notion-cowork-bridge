import ignore from "ignore";
import { readFile } from "node:fs/promises";
import path from "node:path";

export const TRASH_DIR_NAME = ".bridge-trash";
export const DEFAULT_IGNORE_NAMES = [
  ".git",
  "node_modules",
  "dist",
  "build",
  "target",
  ".venv",
  "__pycache__",
  TRASH_DIR_NAME,
];

export function globToRegExp(glob) {
  let source = "^";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === "*") {
      if (glob[index + 1] === "*") {
        source += ".*";
        index += 1;
      } else source += "[^/]*";
    } else if (char === "?") source += "[^/]";
    else if (".+^${}()|[]\\".includes(char)) source += "\\" + char;
    else source += char;
  }
  return new RegExp(source + "$");
}

async function readIgnoreFile(directory) {
  try {
    return (await readFile(path.join(directory, ".gitignore"), "utf8"))
      .split(/\r?\n/)
      .filter((line) => line && !line.startsWith("#"));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

/** Nested .gitignore matcher with Git-compatible negation handling. */
export async function createIgnoreMatcher(workspaceRoot, basePatterns = DEFAULT_IGNORE_NAMES) {
  const cache = new Map();
  const defaults = ignore().add(basePatterns.map((name) => name + "/"));

  async function rulesFor(directory) {
    const key = path.resolve(directory);
    if (cache.has(key)) return cache.get(key);
    const rules = ignore().add(await readIgnoreFile(key));
    cache.set(key, rules);
    return rules;
  }

  return async (relativePath, isDirectory = false) => {
    const normal = relativePath.split(path.sep).join("/").replace(/^\/+/, "");
    if (!normal) return false;
    const suffix = isDirectory ? normal + "/" : normal;
    if (defaults.ignores(suffix)) return true;
    const segments = normal.split("/");
    for (let depth = 0; depth < segments.length; depth += 1) {
      const prefix = segments.slice(0, depth).join("/");
      const candidate = segments.slice(depth).join("/") + (isDirectory ? "/" : "");
      if ((await rulesFor(path.join(workspaceRoot, prefix))).ignores(candidate)) return true;
    }
    return false;
  };
}
