/**
 * `jev` — the unified TypeSafe Jev CLI: debug questions without building an
 * adapter.
 *
 *   jev ask    --questions q.json [--state s.json] [--model M]
 *   jev models
 *   jev eval   --dataset cases.jsonl
 *
 * runCli is importable and dependency-injectable (stdin, fetchImpl, output
 * sinks) so tests run without a real API or process.
 */
import { readFile } from "node:fs/promises";
import { askJev, listJevModels, type JevConfig, type Questions } from "@jev-harness/core";
import { resolveEnvConfig } from "@jev-harness/kit";
import { runEvalCli } from "@jev-harness/eval/cli";

/** A usage error: bad flags or arguments. Exits 2, not 1. */
export class UsageError extends Error {}

export interface CliIo {
  /** Stdin, pre-read by the caller ("" when a TTY). */
  stdin: string;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
  out(s: string): void;
  err(s: string): void;
}

const USAGE = `jev — TypeSafe Jev (System One) on the command line

Usage:
  jev ask    [--state <file|json|->] --questions <file|json|-> [options]
  jev models [options]
  jev eval   --dataset <cases.json|cases.jsonl> [jev-eval options]
  jev help

Commands:
  ask     One batched ask: a state judged against typed questions. Prints the
          JSON response (probabilities per question) to stdout.
          --state/--questions accept a file path, inline JSON, or '-' for
          stdin. With no flags, stdin is read as {"state":..., "questions":...}.
          state defaults to {} when only questions are given.
  models  List available Jev models.
  eval    Evaluate questions against a labeled dataset (delegates to jev-eval;
          see jev eval --help).

Options:
  --model <name>      Override TYPESAFE_DEFAULT_MODEL for this call.
  --base-url <url>    Override TYPESAFE_BASE_URL.
  --timeout-ms <n>    Per-request timeout in ms (default 15000).
  -h, --help          Show help.

Environment:
  TYPESAFE_API_KEY        Required. Never hardcoded, never logged.
  TYPESAFE_BASE_URL       Override. Default https://api.typesafe.ai.
  TYPESAFE_DEFAULT_MODEL  Override. Default jev-latest.
  JEV_TIMEOUT_MS          Override. Per-request timeout in ms.

Examples:
  jev ask --questions '{"gate":{"type":"noul","instructions":"destructive?"}}'
  cat request.json | jev ask
  jev eval --dataset cases.jsonl --out report.json`;

interface AskArgs {
  state?: string;
  questions?: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  help?: boolean;
}

interface SimpleArgs {
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  help?: boolean;
}

function parseCommonFlags(argv: string[]): { args: SimpleArgs; rest: Array<[string, string]> } {
  const args: SimpleArgs = {};
  const rest: Array<[string, string]> = [];
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new UsageError(`${flag} expects a value (see jev help)`);
      return v;
    };
    switch (flag) {
      case "--model": args.model = next(); break;
      case "--base-url": args.baseUrl = next(); break;
      case "--timeout-ms": {
        const n = Number(next());
        if (!Number.isFinite(n) || n <= 0) throw new UsageError("--timeout-ms must be a positive number");
        args.timeoutMs = Math.floor(n);
        break;
      }
      case "-h": case "--help": args.help = true; break;
      default: rest.push([flag, next()]);
    }
  }
  return { args, rest };
}

function parseAskArgs(argv: string[]): AskArgs {
  const { args, rest } = parseCommonFlags(argv);
  const out: AskArgs = { ...args };
  for (const [flag, value] of rest) {
    if (flag === "--state") out.state = value;
    else if (flag === "--questions") out.questions = value;
    else throw new UsageError(`unknown flag: ${flag} (see jev help)`);
  }
  return out;
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new UsageError(`${label} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Resolve one JSON input: '-' = stdin, inline JSON (starts with { or [),
 * otherwise a file path. Returns the parsed value.
 */
async function resolveJsonInput(raw: string, stdin: string, label: string): Promise<unknown> {
  if (raw === "-") {
    if (!stdin.trim()) throw new UsageError(`${label}: '-' means stdin but stdin is empty`);
    return parseJson(stdin, label);
  }
  if (raw.trimStart().startsWith("{") || raw.trimStart().startsWith("[")) return parseJson(raw, label);
  let text: string;
  try {
    text = await readFile(raw, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new UsageError(`${label}: file not found: ${raw} (pass a path, inline JSON, or '-')`);
    }
    throw err;
  }
  return parseJson(text, label);
}

/** Env config + per-call flag overrides + injectable fetch. */
function buildConfig(opts: { model?: string; baseUrl?: string; timeoutMs?: number }, io: CliIo): JevConfig {
  const cfg = resolveEnvConfig({ requireKey: true, modelOverride: opts.model });
  if (opts.baseUrl) cfg.baseUrl = opts.baseUrl.replace(/\/+$/, "");
  if (opts.timeoutMs !== undefined) cfg.timeoutMs = opts.timeoutMs;
  if (io.fetchImpl) cfg.fetchImpl = io.fetchImpl;
  return cfg;
}

async function askCommand(argv: string[], io: CliIo): Promise<number> {
  const args = parseAskArgs(argv);
  if (args.help) {
    io.out(USAGE + "\n");
    return 0;
  }

  const stdin = io.stdin ?? "";
  let questions: unknown;
  let envelopeState: unknown;
  let hasEnvelope = false;

  if (args.questions !== undefined) {
    questions = await resolveJsonInput(args.questions, stdin, "--questions");
  } else if (stdin.trim()) {
    const env = tryParse(stdin);
    if (env && typeof env === "object" && env !== null && "questions" in (env as Record<string, unknown>)) {
      questions = (env as Record<string, unknown>).questions;
      envelopeState = (env as Record<string, unknown>).state;
      hasEnvelope = true;
    }
  }
  if (questions === undefined) {
    throw new UsageError(
      "questions are required: pass --questions <file|json|-> or pipe {\"state\":...,\"questions\":...} to stdin",
    );
  }

  let state: unknown = {};
  if (args.state !== undefined) state = await resolveJsonInput(args.state, stdin, "--state");
  else if (hasEnvelope && envelopeState !== undefined) state = envelopeState;

  const response = await askJev(buildConfig(args, io), state, questions as Questions);
  io.out(JSON.stringify(response, null, 2) + "\n");
  return 0;
}

async function modelsCommand(argv: string[], io: CliIo): Promise<number> {
  const { args } = parseCommonFlags(argv);
  if (args.help) {
    io.out(USAGE + "\n");
    return 0;
  }
  const models = await listJevModels(buildConfig(args, io));
  io.out(JSON.stringify(models, null, 2) + "\n");
  return 0;
}

async function evalCommand(argv: string[], io: CliIo): Promise<number> {
  if (argv.includes("-h") || argv.includes("--help")) {
    io.out("jev eval — evaluate Jev questions against a labeled dataset\n\nDelegates to jev-eval.\n\n");
    await runEvalCli(["--help"]);
    return 0;
  }
  await runEvalCli(argv);
  return 0;
}

/** Run one jev invocation. Returns the process exit code (0/1/2). */
export async function runCli(argv: string[], io: Partial<CliIo> = {}): Promise<number> {
  const sinks: CliIo = {
    stdin: io.stdin ?? "",
    fetchImpl: io.fetchImpl,
    out: io.out ?? ((s) => process.stdout.write(s)),
    err: io.err ?? ((s) => process.stderr.write(s)),
  };

  const [command, ...rest] = argv;
  if (command === undefined || command === "help") {
    if (command === undefined) sinks.err(USAGE + "\n");
    else sinks.out(USAGE + "\n");
    return command === undefined ? 2 : 0;
  }
  if (command === "-h" || command === "--help") {
    sinks.out(USAGE + "\n");
    return 0;
  }

  try {
    switch (command) {
      case "ask": return await askCommand(rest, sinks);
      case "models": return await modelsCommand(rest, sinks);
      case "eval": return await evalCommand(rest, sinks);
      default:
        sinks.err(`unknown command: ${command} (try \`jev help\`)\n`);
        return 2;
    }
  } catch (err) {
    if (err instanceof UsageError) {
      sinks.err(err.message + "\n");
      return 2;
    }
    sinks.err((err instanceof Error ? err.message : String(err)) + "\n");
    return 1;
  }
}
