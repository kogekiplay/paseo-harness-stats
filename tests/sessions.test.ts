import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, appendFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionReader } from "../server/sessions";

test("Incremental reads wait for complete lines, share concurrent reads, and handle truncation", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-stats-"));
  try {
    const id = "11111111-2222-3333-4444-555555555555";
    const dir = join(root, "sessions", "2026", "11", "16");
    await mkdir(dir, { recursive: true });
    const path = join(dir, `rollout-2026-11-16T12-00-00-${id}.jsonl`);
    const row = (response: string) =>
      JSON.stringify({
        type: "token_usage_record",
        payload: {
          response_id: response,
          turn_id: "t",
          usage: { input_tokens: 100, output_tokens: 10 },
        },
      });
    const first = row("r1");
    await writeFile(path, first.slice(0, 40));
    const reader = new SessionReader({ codex: root, claude: root });
    assert.equal((await reader.read("codex", id, "/x")).steps, 0);
    await appendFile(path, first.slice(40) + "\n");
    const results = await Promise.all([
      reader.read("codex", id, "/x"),
      reader.read("codex", id, "/x"),
    ]);
    assert.deepEqual(
      results.map((s) => s.steps),
      [1, 1],
    );
    await appendFile(path, row("r2") + "\n");
    assert.equal((await reader.read("codex", id, "/x")).steps, 2);
    await writeFile(path, row("r3") + "\n");
    assert.equal((await reader.read("codex", id, "/x")).steps, 1);
    assert.equal((await reader.read("codex", "../../outside", "/x")).source, "unavailable");
    assert.equal((await reader.read("other", id, "/x")).source, "unsupported");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
