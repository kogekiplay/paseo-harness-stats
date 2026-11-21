import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { emptyStats, type Stats } from "../shared/stats";
import { AntigravityReader } from "./antigravity";
import { SessionFold } from "./fold";

interface CachedSession {
  fold: SessionFold;
  offset: number;
  ino: number;
  tail: string;
  decoder: StringDecoder;
  busy: Promise<Stats> | null;
}

/** Reads only appended bytes; the cache contains counters, never conversation text. */
export class SessionReader {
  private cache = new Map<string, CachedSession>();
  private codexPaths = new Map<string, string>();
  private indexAt = 0;
  private indexing: Promise<void> | null = null;
  private antigravity: AntigravityReader;
  constructor(
    private roots = {
      codex: process.env.CODEX_HOME || join(homedir(), ".codex"),
      claude: process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
    },
    antigravityRoot?: string,
  ) {
    this.antigravity = new AntigravityReader(antigravityRoot);
  }

  private async exists(path: string): Promise<boolean> {
    try {
      return (await stat(path)).isFile();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  private async indexCodex() {
    if (this.indexing) return this.indexing;
    if (Date.now() - this.indexAt < 15_000) return;
    this.indexing = (async () => {
      const root = join(this.roots.codex, "sessions");
      let files: string[];
      try {
        files = await readdir(root, { recursive: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        files = [];
      }
      for (const file of files) {
        const match = /rollout-.*-([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl$/i.exec(file);
        if (match) this.codexPaths.set(match[1], join(root, file));
      }
      this.indexAt = Date.now();
    })();
    try {
      await this.indexing;
    } finally {
      this.indexing = null;
    }
  }
  async locate(
    provider: "codex" | "claude",
    sessionId: string,
    cwd: string,
  ): Promise<string | null> {
    if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) return null;
    if (provider === "codex") {
      const cached = this.codexPaths.get(sessionId);
      if (cached && (await this.exists(cached))) return cached;
      await this.indexCodex();
      return this.codexPaths.get(sessionId) ?? null;
    }
    const root = join(this.roots.claude, "projects");
    if (isAbsolute(cwd)) {
      const direct = join(root, cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${sessionId}.jsonl`);
      if (await this.exists(direct)) return direct;
    }
    let projects: string[];
    try {
      projects = await readdir(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    for (const project of projects) {
      const file = join(root, project, `${sessionId}.jsonl`);
      if (await this.exists(file)) return file;
    }
    return null;
  }
  async read(provider: string, sessionId: string | null, cwd: string): Promise<Stats> {
    if (provider === "antigravity") return this.antigravity.read(sessionId);
    if (provider !== "codex" && provider !== "claude") return emptyStats(provider, "unsupported");
    if (!sessionId) return emptyStats(provider, "unavailable");
    const path = await this.locate(provider, sessionId, cwd);
    if (!path) return emptyStats(provider, "unavailable");
    let cached = this.cache.get(path);
    if (!cached) {
      cached = {
        fold: new SessionFold(provider),
        offset: 0,
        ino: 0,
        tail: "",
        decoder: new StringDecoder("utf8"),
        busy: null,
      };
      this.cache.set(path, cached);
    }
    // Concurrent windows share one read, including the initial full-log fold.
    if (cached.busy) return cached.busy;
    this.cache.delete(path);
    this.cache.set(path, cached);
    if (this.cache.size > 32) {
      for (const [key, entry] of this.cache) {
        if (key !== path && !entry.busy) {
          this.cache.delete(key);
          break;
        }
      }
    }
    const entry = cached;
    entry.busy = (async () => {
      const info = await stat(path);
      if (entry.ino !== info.ino || info.size < entry.offset) {
        entry.fold = new SessionFold(provider);
        entry.offset = 0;
        entry.tail = "";
        entry.decoder = new StringDecoder("utf8");
      }
      entry.ino = info.ino;
      if (info.size > entry.offset) {
        const stream = createReadStream(path, { start: entry.offset, end: info.size - 1 });
        for await (const buffer of stream) {
          const chunk = entry.tail + entry.decoder.write(buffer);
          const lines = chunk.split("\n");
          entry.tail = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.trim()) continue;
            let row: unknown;
            try {
              row = JSON.parse(line);
            } catch {
              throw new Error("Session log contains an invalid JSON line");
            }
            entry.fold.apply(row);
          }
        }
        entry.offset = info.size;
      }
      return { ...entry.fold.stats };
    })();
    try {
      return await entry.busy;
    } catch (error) {
      this.cache.delete(path);
      throw error;
    } finally {
      entry.busy = null;
    }
  }
  clear() {
    this.antigravity.clear();
    this.cache.clear();
    this.codexPaths.clear();
  }
}
