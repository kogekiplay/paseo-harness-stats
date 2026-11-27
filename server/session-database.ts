import { stat } from "node:fs/promises";
import type * as Sqlite from "node:sqlite";

export function builtinSqlite() {
  return process.getBuiltinModule?.("node:sqlite") as typeof Sqlite | undefined;
}

export async function databaseFingerprint(path: string): Promise<string | null> {
  try {
    const file = await stat(path, { bigint: true });
    return file.isFile() ? `${file.ino}:${file.size}:${file.mtimeNs}:${file.ctimeNs}` : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
