import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runEvalCli } from "../src/cli.js";

const ENV_KEYS = ["TYPESAFE_API_KEY"] as const;
const SAVED_KEY = process.env.TYPESAFE_API_KEY;
beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});
afterEach(() => {
  if (SAVED_KEY !== undefined) process.env.TYPESAFE_API_KEY = SAVED_KEY;
  else for (const k of ENV_KEYS) delete process.env[k];
});

function sinks() {
  const captured = { out: [] as string[], err: [] as string[] };
  return {
    io: {
      out: (s: string) => void captured.out.push(s),
      err: (s: string) => void captured.err.push(s),
    },
    read: () => ({ out: captured.out.join(""), err: captured.err.join("") }),
  };
}

async function datasetFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "jev-eval-cli-"));
  const path = join(dir, "cases.jsonl");
  await writeFile(
    path,
    [
      `{"questions": {"q": {"type": "noul", "instructions": "ok?"}}, "state": {"n": 1}, "label": {"q": true}}`,
      `{"state": {"n": 2}, "label": {"q": false}}`,
    ].join("\n"),
  );
  return path;
}

describe("runEvalCli exit codes", () => {
  it("returns 2 on usage errors without calling process.exit", async () => {
    const s = sinks();
    expect(await runEvalCli([], s.io)).toBe(2);
    expect(s.read().err).toMatch(/--dataset is required/);
    const unknown = sinks();
    expect(await runEvalCli(["--nope"], unknown.io)).toBe(2);
    const missing = await datasetFile();
    const noKey = sinks();
    expect(await runEvalCli(["--dataset", missing, "--no-sweep"], noKey.io)).toBe(2);
    expect(noKey.read().err).toMatch(/TYPESAFE_API_KEY/);
  });

  it("returns 0 on --help without a key", async () => {
    const s = sinks();
    expect(await runEvalCli(["--help"], s.io)).toBe(0);
    expect(s.read().out).toMatch(/jev-eval/);
  });

  it("returns 1 when every case failed, 0 with --no-fail", async () => {
    process.env.TYPESAFE_API_KEY = "k";
    const path = await datasetFile();
    // Unreachable API: retries surface as per-case failures, never a throw.
    const fail = sinks();
    const failingFetch = (async () =>
      new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const realFetch = globalThis.fetch;
    (globalThis as { fetch: typeof fetch }).fetch = failingFetch;
    try {
      expect(await runEvalCli(["--dataset", path, "--no-sweep"], fail.io)).toBe(1);
      expect(fail.read().err).toMatch(/case\(s\) failed/);
      const exploratory = sinks();
      expect(await runEvalCli(["--dataset", path, "--no-sweep", "--no-fail"], exploratory.io)).toBe(
        0,
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
