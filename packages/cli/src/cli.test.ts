import { afterEach, describe, it, expect } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli, type CliIo } from "./cli.js";
import type { JevResponse } from "@jev-harness/core";

const ENV_KEYS = [
  "TYPESAFE_API_KEY",
  "TYPESAFE_BASE_URL",
  "TYPESAFE_DEFAULT_MODEL",
  "JEV_TIMEOUT_MS",
] as const;

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
    const code = await runCli(["ask", "--state", "/no/such/file.json", "--questions", "{}"], {
      ...cap.io,
    });
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

  it("caps --timeout-ms at 2^31-1 instead of overflowing setTimeout", async () => {
    process.env.TYPESAFE_API_KEY = "k";
    const { impl } = echoFetch();
    const cap = capture();
    const code = await runCli(
      [
        "ask",
        "--questions",
        '{"q":{"type":"noul","instructions":"ok?"}}',
        "--timeout-ms",
        "99999999999",
      ],
      { fetchImpl: impl, ...cap.io },
    );
    expect(code).toBe(0);
    const bad = capture();
    expect(
      await runCli(
        ["ask", "--questions", '{"q":{"type":"noul","instructions":"ok?"}}', "--timeout-ms", "0"],
        {
          fetchImpl: impl,
          ...bad.io,
        },
      ),
    ).toBe(2);
  });

  it("prints usage for jev eval --help without a key", async () => {
    const cap = capture();
    const code = await runCli(["eval", "--help"], { ...cap.io });
    expect(code).toBe(0);
    expect(cap.read().out).toMatch(/jev-eval/);
  });

  it("propagates the eval exit code instead of always exiting 0", async () => {
    process.env.TYPESAFE_API_KEY = "k";
    // Missing --dataset is a usage error: jev eval must surface exit 2,
    // not swallow it as 0 the way the old `await runEvalCli(argv); return 0` did.
    const missing = capture();
    expect(await runCli(["eval"], { ...missing.io })).toBe(2);
    expect(missing.read().err).toMatch(/--dataset is required/);
    // Unknown eval flag is also a usage error, propagated through.
    const bad = capture();
    expect(await runCli(["eval", "--nope"], { ...bad.io })).toBe(2);
  });
});
/**
 * jev classify — the same questions over a JSONL corpus: one request per item,
 * one result line per item, and an optional reduce over the capped digest of
 * the per-item verdicts (never the corpus).
 */
function classifyFetch(opts: { fail400For?: (body: any) => boolean } = {}) {
  const bodies: any[] = [];
  const impl = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    if (opts.fail400For?.(body)) return new Response("bad item payload", { status: 400 });
    const answers: Record<string, unknown> = {};
    for (const id of Object.keys(body.questions ?? {})) {
      answers[id] = { type: "noul", noul: 0.5 };
    }
    return new Response(JSON.stringify({ model: body.model, answers }), { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, bodies };
}

const itemBodies = (bodies: any[]) => bodies.filter((b) => !("answers" in b.state));

describe("jev classify", () => {
  it("runs the same questions over each JSONL item", async () => {
    process.env.TYPESAFE_API_KEY = "k";
    const dir = await mkdtemp(join(tmpdir(), "jev-cli-"));
    const itemsFile = join(dir, "items.jsonl");
    await writeFile(itemsFile, '{"id":1}\n\n{"id":2}\n{"id":3}\n');
    const questionsFile = join(dir, "q.json");
    await writeFile(questionsFile, JSON.stringify({ q: { type: "noul", instructions: "ok?" } }));
    const { impl, bodies } = classifyFetch();
    const cap = capture();
    const code = await runCli(["classify", "--items", itemsFile, "--questions", questionsFile], {
      fetchImpl: impl,
      ...cap.io,
    });
    expect(code).toBe(0);
    expect(itemBodies(bodies)).toHaveLength(3);
    const lines = cap
      .read()
      .out.trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines.map((l) => l.index)).toEqual([0, 1, 2]);
    for (const line of lines) expect(line.answers.q.noul).toBe(0.5);
    expect(cap.read().err).toBe("");
  });

  it("accepts one question (not just a map) and wraps it as 'answer'", async () => {
    process.env.TYPESAFE_API_KEY = "k";
    const { impl, bodies } = classifyFetch();
    const cap = capture();
    const code = await runCli(
      ["classify", "--items", "-", "--questions", '{"type":"noul","instructions":"is it good?"}'],
      { fetchImpl: impl, stdin: '"a"\n"b"\n', ...cap.io },
    );
    expect(code).toBe(0);
    expect(Object.keys(bodies[0].questions)).toEqual(["answer"]);
    expect(cap.read().out.trim().split("\n")).toHaveLength(2);
  });

  it("judges the reduce over a capped digest of verdicts, never the corpus", async () => {
    process.env.TYPESAFE_API_KEY = "k";
    const itemsFile = join(await mkdtemp(join(tmpdir(), "jev-cli-")), "items.jsonl");
    const items = Array.from({ length: 230 }, (_, i) => JSON.stringify("corpus-item-" + i));
    await writeFile(itemsFile, items.join("\n") + "\n");
    const { impl, bodies } = classifyFetch();
    const cap = capture();
    const code = await runCli(
      [
        "classify",
        "--items",
        itemsFile,
        "--questions",
        '{"q":{"type":"noul","instructions":"ok?"}}',
        "--reduce",
        '{"instructions":"summarize","criteria":["bad","good"]}',
      ],
      { fetchImpl: impl, ...cap.io },
    );
    expect(code).toBe(0);
    expect(itemBodies(bodies)).toHaveLength(230);
    const reduceBody = bodies.find((b) => "answers" in b.state)!;
    expect(reduceBody.state.item_count).toBe(230);
    expect(reduceBody.state.answers).toHaveLength(200);
    expect(reduceBody.state.omitted_items).toBe(30);
    expect(JSON.stringify(reduceBody.state)).not.toContain("corpus-item");
    const lines = cap
      .read()
      .out.trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines).toHaveLength(231);
    expect(lines[230]).toHaveProperty("reduced");
  });

  it("reports the failed indices and still emits every success", async () => {
    process.env.TYPESAFE_API_KEY = "k";
    const dir = await mkdtemp(join(tmpdir(), "jev-cli-"));
    const itemsFile = join(dir, "items.jsonl");
    await writeFile(itemsFile, ['"ok-1"', '"poison"', '"ok-2"'].join("\n") + "\n");
    const { impl, bodies } = classifyFetch({ fail400For: (b) => b.state?.item === "poison" });
    const cap = capture();
    const code = await runCli(
      [
        "classify",
        "--items",
        itemsFile,
        "--questions",
        '{"q":{"type":"noul","instructions":"ok?"}}',
      ],
      { fetchImpl: impl, ...cap.io },
    );
    expect(code).toBe(1);
    // Batch rejected once, then each item retried alone: 3 + 3 requests.
    expect(itemBodies(bodies)).toHaveLength(6);
    const lines = cap
      .read()
      .out.trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toHaveProperty("answers");
    expect(lines[1].error).toMatch(/400/);
    expect(lines[1].index).toBe(1);
    expect(lines[2]).toHaveProperty("answers");
    expect(cap.read().err).toMatch(/item 1: /);
  });

  it("writes the JSONL to --out and keeps stdout clean", async () => {
    process.env.TYPESAFE_API_KEY = "k";
    const dir = await mkdtemp(join(tmpdir(), "jev-cli-"));
    const outFile = join(dir, "out.jsonl");
    const { impl } = classifyFetch();
    const cap = capture();
    const code = await runCli(
      [
        "classify",
        "--items",
        "-",
        "--questions",
        '{"q":{"type":"noul","instructions":"ok?"}}',
        "--out",
        outFile,
      ],
      { fetchImpl: impl, stdin: '"a"\n"b"\n', ...cap.io },
    );
    expect(code).toBe(0);
    expect(cap.read().out).toBe("");
    const written = await readFile(outFile, "utf8");
    expect(written.trim().split("\n")).toHaveLength(2);
  });

  it("fails clearly when the key is missing and for bad usage", async () => {
    const missingKey = capture();
    expect(
      await runCli(
        ["classify", "--items", "-", "--questions", '{"q":{"type":"noul","instructions":"ok?"}}'],
        { stdin: "1\n", ...missingKey.io },
      ),
    ).toBe(1);
    expect(missingKey.read().err).toMatch(/TYPESAFE_API_KEY/);

    process.env.TYPESAFE_API_KEY = "k";
    const noItems = capture();
    expect(await runCli(["classify", "--questions", "{}"], { ...noItems.io })).toBe(2);
    expect(noItems.read().err).toMatch(/--items is required/);

    const badJsonl = capture();
    expect(
      await runCli(["classify", "--items", "-", "--questions", "{}"], {
        stdin: "1\nnot json\n",
        ...badJsonl.io,
      }),
    ).toBe(2);
    expect(badJsonl.read().err).toMatch(/--items: line 2 is not valid JSON/);

    const bothStdin = capture();
    expect(
      await runCli(["classify", "--items", "-", "--questions", "-"], {
        stdin: "1\n",
        ...bothStdin.io,
      }),
    ).toBe(2);
    expect(bothStdin.read().err).toMatch(/cannot both read stdin/);
  });

  it("prints usage for classify --help without a key", async () => {
    const cap = capture();
    expect(await runCli(["classify", "--help"], { ...cap.io })).toBe(0);
    expect(cap.read().out).toMatch(/jev classify/);
  });
});
