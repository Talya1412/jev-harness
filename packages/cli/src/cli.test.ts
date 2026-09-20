import { afterEach, describe, it, expect } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli, type CliIo } from "./cli.js";
import type { JevResponse } from "@jev-harness/core";

const ENV_KEYS = ["TYPESAFE_API_KEY", "TYPESAFE_BASE_URL", "TYPESAFE_DEFAULT_MODEL", "JEV_TIMEOUT_MS"] as const;

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

/** One noul answer per requested question, recording request bodies. */
function echoFetch() {
  const bodies: any[] = [];
  const impl = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    const answers: JevResponse["answers"] = {};
    for (const id of Object.keys(body.questions)) answers[id] = { type: "noul", noul: 0.5 };
    return new Response(JSON.stringify({ model: body.model, answers }), { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, bodies };
}

function capture(): { io: Partial<CliIo>; read: () => { out: string; err: string } } {
  const captured = { out: [] as string[], err: [] as string[] };
  return {
    io: {
      out: (s: string) => {
        captured.out.push(s);
      },
      err: (s: string) => {
        captured.err.push(s);
      },
    },
    read: () => ({ out: captured.out.join(""), err: captured.err.join("") }),
  };
}

describe("runCli", () => {
  it("asks with inline JSON flags and applies flag overrides", async () => {
    process.env.TYPESAFE_API_KEY = "k";
    process.env.TYPESAFE_DEFAULT_MODEL = "pinned";
    const { impl, bodies } = echoFetch();
    const cap = capture();
    const code = await runCli(
      [
        "ask",
        "--state",
        '{"tool":"bash"}',
        "--questions",
        '{"gate":{"type":"noul","instructions":"destructive?"}}',
        "--model",
        "jev-1.13.0",
        "--timeout-ms",
        "5000",
      ],
      { fetchImpl: impl, ...cap.io },
    );
    expect(code).toBe(0);
    const { out } = cap.read();
    const parsed = JSON.parse(out);
    expect(parsed.answers.gate.noul).toBe(0.5);
    expect(bodies[0].model).toBe("jev-1.13.0");
    expect(bodies[0].state).toEqual({ tool: "bash" });
  });

  it("defaults state to {} and reads a questions file from disk", async () => {
    process.env.TYPESAFE_API_KEY = "k";
    const dir = await mkdtemp(join(tmpdir(), "jev-cli-"));
    const qFile = join(dir, "questions.json");
    await writeFile(qFile, JSON.stringify({ q: { type: "noul", instructions: "ok?" } }));
    const { impl, bodies } = echoFetch();
    const cap = capture();
    const code = await runCli(["ask", "--questions", qFile], { fetchImpl: impl, ...cap.io });
    expect(code).toBe(0);
    expect(bodies[0].state).toEqual({});
    expect(Object.keys(bodies[0].questions)).toEqual(["q"]);
  });

  it("accepts a {state, questions} envelope on stdin when flags are omitted", async () => {
    process.env.TYPESAFE_API_KEY = "k";
    const { impl, bodies } = echoFetch();
    const cap = capture();
    const code = await runCli(["ask"], {
      fetchImpl: impl,
      stdin: '{"state":{"a":1},"questions":{"q":{"type":"noul","instructions":"ok?"}}}',
      ...cap.io,
    });
    expect(code).toBe(0);
    expect(bodies[0].state).toEqual({ a: 1 });
  });

  it("reads '-' inputs from stdin", async () => {
    process.env.TYPESAFE_API_KEY = "k";
    const { impl, bodies } = echoFetch();
    const cap = capture();
    const stdinJson = '{"gate":{"type":"noul","instructions":"ok?"}}';
    const code = await runCli(["ask", "--state", "-", "--questions", "-"], {
      fetchImpl: impl,
      stdin: stdinJson,
      ...cap.io,
    });
    expect(code).toBe(0);
    expect(bodies[0].state).toEqual(JSON.parse(stdinJson));
    expect(bodies[0].questions).toEqual(JSON.parse(stdinJson));
  });

  it("fails with a clear message when the key is missing", async () => {
    const cap = capture();
    const code = await runCli(["ask", "--questions", "{}"], { ...cap.io });
    expect(code).toBe(1);
    expect(cap.read().err).toMatch(/TYPESAFE_API_KEY/);
  });

  it("returns 2 for unknown flags and commands, 0 for help", async () => {
    process.env.TYPESAFE_API_KEY = "k";
    const bad = capture();
    expect(await runCli(["ask", "--nope", "x"], { ...bad.io })).toBe(2);
    const unknown = capture();
    expect(await runCli(["frobnicate"], { ...unknown.io })).toBe(2);
    expect(unknown.read().err).toMatch(/unknown command: frobnicate/);

    const help = capture();
    expect(await runCli(["help"], { ...help.io })).toBe(0);
    expect(help.read().out).toMatch(/jev ask/);
    expect(await runCli([], { ...capture().io })).toBe(2);
  });

  it("reports invalid JSON with the label and exit code 2", async () => {
    process.env.TYPESAFE_API_KEY = "k";
    const cap = capture();
    const code = await runCli(["ask", "--questions", "{nope"], { ...cap.io });
    expect(code).toBe(2);
    expect(cap.read().err).toMatch(/--questions is not valid JSON/);
  });

  it("gives a friendly error for a missing state file", async () => {
    process.env.TYPESAFE_API_KEY = "k";
    const cap = capture();
    const code = await runCli(["ask", "--state", "/no/such/file.json", "--questions", "{}"], { ...cap.io });
    expect(code).toBe(2);
    expect(cap.read().err).toMatch(/--state: file not found/);
  });

  it("lists models as JSON", async () => {
    process.env.TYPESAFE_API_KEY = "k";
    const impl = (async () =>
      new Response(JSON.stringify({ models: [{ name: "jev-latest", description: "d" }] }), {
        status: 200,
      })) as unknown as typeof fetch;
    const cap = capture();
    const code = await runCli(["models"], { fetchImpl: impl, ...cap.io });
    expect(code).toBe(0);
    expect(JSON.parse(cap.read().out)).toEqual([{ name: "jev-latest", description: "d" }]);
  });

  it("prints usage for jev eval --help without a key", async () => {
    const cap = capture();
    const code = await runCli(["eval", "--help"], { ...cap.io });
    expect(code).toBe(0);
    expect(cap.read().out).toMatch(/jev-eval/);
  });
});
