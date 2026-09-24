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
import { readFile, writeFile } from "node:fs/promises";
import {
  askJev,
  JevError,
  listJevModels,
  withMapReduce,
  type Answer,
  type JevConfig,
  type MapReduceOptions,
  type Questions,
} from "@jev-harness/core";
import { parseTimeoutMs, resolveEnvConfig } from "@jev-harness/kit";
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
  jev ask      [--state <file|json|->] --questions <file|json|-> [options]
  jev models   [options]
  jev classify --items <file|-> --questions <file|json> [classify options]
  jev eval     --dataset <cases.json|cases.jsonl> [jev-eval options]
  jev help

Commands:
  ask     One batched ask: a state judged against typed questions. Prints the
          JSON response (probabilities per question) to stdout.
          --state/--questions accept a file path, inline JSON, or '-' for
          stdin. With no flags, stdin is read as {"state":..., "questions":...}.
          state defaults to {} when only questions are given.
  models  List available Jev models.
  classify
          The SAME questions over a JSONL corpus: one request per item, one
          JSON result line per item. Cost is items x questions. --questions
          takes a map of id -> question, or ONE question (wrapped as id
          "answer"). --reduce asks one extra question over the per-item
          verdicts (a capped digest, never the corpus). A failing item is
          reported with its index and does not stop the batch; the command
          still prints every other result and exits 1.
  eval    Evaluate questions against a labeled dataset (delegates to jev-eval;
          see jev eval --help).

Options:
  --model <name>      Override TYPESAFE_DEFAULT_MODEL for this call.
  --base-url <url>    Override TYPESAFE_BASE_URL.
  --timeout-ms <n>    Per-request timeout in ms (default 15000).
  -h, --help          Show help.

classify options:
  --items <file|->      JSONL corpus: one JSON value per line ('-' = stdin).
  --questions <file|->  A map of id -> question, or one question object.
  --reduce <file|->     Optional final question over the per-item verdicts.
  --out <file>          Write the JSONL result lines to a file (default stdout).
  --concurrency <n>     Item judgments in flight at once (default 4).

Environment:
  TYPESAFE_API_KEY        Required. Never hardcoded, never logged.
  TYPESAFE_BASE_URL       Override. Default https://api.typesafe.ai.
  TYPESAFE_DEFAULT_MODEL  Override. Default jev-latest.
  JEV_TIMEOUT_MS          Override. Per-request timeout in ms.

Examples:
  jev ask --questions '{"gate":{"type":"noul","instructions":"destructive?"}}'
  cat request.json | jev ask
  jev eval --dataset cases.jsonl --out report.json
  jev classify --items posts.jsonl --questions q.json --reduce reduce.json
  cat logs.jsonl | jev classify --items - --questions '{"severity":{"type":"choice",
    "instructions":"how severe?","criteria":{"low":"cosmetic","high":"outage"}}}'`;

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
      case "--model":
        args.model = next();
        break;
      case "--base-url":
        args.baseUrl = next();
        break;
      case "--timeout-ms": {
        // Shared capped parser: huge values cannot overflow setTimeout into ~1ms.
        const n = parseTimeoutMs(next());
        if (n === undefined) throw new UsageError("--timeout-ms must be a positive number");
        args.timeoutMs = n;
        break;
      }
      case "-h":
      case "--help":
        args.help = true;
        break;
      default:
        rest.push([flag, next()]);
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
    throw new UsageError(
      `${label} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
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
  if (raw.trimStart().startsWith("{") || raw.trimStart().startsWith("["))
    return parseJson(raw, label);
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
function buildConfig(
  opts: { model?: string; baseUrl?: string; timeoutMs?: number },
  io: CliIo,
): JevConfig {
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
    if (
      env &&
      typeof env === "object" &&
      env !== null &&
      "questions" in (env as Record<string, unknown>)
    ) {
      questions = (env as Record<string, unknown>).questions;
      envelopeState = (env as Record<string, unknown>).state;
      hasEnvelope = true;
    }
  }
  if (questions === undefined) {
    throw new UsageError(
      'questions are required: pass --questions <file|json|-> or pipe {"state":...,"questions":...} to stdin',
    );
  }

  let state: unknown = {};
  if (args.state !== undefined) state = await resolveJsonInput(args.state, stdin, "--state");
  else if (hasEnvelope && envelopeState !== undefined) state = envelopeState;

  const response = await askJev(buildConfig(args, io), state, questions as Questions);
  io.out(JSON.stringify(response, null, 2) + "\n");
  return 0;
}

interface ClassifyArgs {
  items?: string;
  questions?: string;
  reduce?: string;
  out?: string;
  concurrency?: number;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  help?: boolean;
}

function parseClassifyArgs(argv: string[]): ClassifyArgs {
  const { args, rest } = parseCommonFlags(argv);
  const out: ClassifyArgs = { ...args };
  for (const [flag, value] of rest) {
    if (flag === "--items") out.items = value;
    else if (flag === "--questions") out.questions = value;
    else if (flag === "--reduce") out.reduce = value;
    else if (flag === "--out") out.out = value;
    else if (flag === "--concurrency") {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 1) {
        throw new UsageError("--concurrency must be a positive number");
      }
      out.concurrency = Math.floor(n);
    } else throw new UsageError(`unknown flag: ${flag} (see jev help)`);
  }
  return out;
}

/** A JSONL corpus: one JSON value per line, blank lines skipped. */
function parseJsonl(text: string, label: string): unknown[] {
  const items: unknown[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line === "") continue;
    try {
      items.push(JSON.parse(line));
    } catch (err) {
      throw new UsageError(
        `${label}: line ${i + 1} is not valid JSON: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }
  return items;
}

/** Read JSONL text: "-" = stdin, otherwise a file path. */
async function readTextInput(raw: string, stdin: string, label: string): Promise<string> {
  if (raw === "-") {
    if (!stdin.trim()) throw new UsageError(`${label}: '-' means stdin but stdin is empty`);
    return stdin;
  }
  try {
    return await readFile(raw, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new UsageError(`${label}: file not found: ${raw} (pass a path or '-')`);
    }
    throw err;
  }
}

/**
 * One Question or a map of them, matching what core asks: a single question
 * is wrapped as id "answer" so the per-item results keep a stable shape.
 */
function asQuestions(value: unknown, label: string): Questions {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new UsageError(`${label} must be a question object or a map of id -> question`);
  }
  const rec = value as Record<string, unknown>;
  if (typeof rec.instructions === "string") {
    return { answer: rec } as unknown as Questions;
  }
  const keys = Object.keys(rec);
  if (keys.length === 0) throw new UsageError(`${label} must not be empty`);
  for (const key of keys) {
    const q = rec[key];
    if (
      !q ||
      typeof q !== "object" ||
      typeof (q as { instructions?: unknown }).instructions !== "string"
    ) {
      throw new UsageError(`${label}.${key} must be a question with an instructions string`);
    }
  }
  return rec as unknown as Questions;
}

/** A reduce question in the parts core takes (MapReduceOptions.reduce). */
function asReduceQuestion(value: unknown, label: string): NonNullable<MapReduceOptions["reduce"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new UsageError(`${label} must be a question object`);
  }
  const rec = value as Record<string, unknown>;
  if (typeof rec.instructions !== "string" || rec.instructions.length === 0) {
    throw new UsageError(`${label}.instructions must be a non-empty string`);
  }
  if (rec.criteria === undefined) {
    throw new UsageError(`${label}.criteria is required: an object of options or an ordered array`);
  }
  const criteria = Array.isArray(rec.criteria)
    ? rec.criteria.map((level) => String(level))
    : (rec.criteria as Record<string, string>);
  const type =
    rec.type === "noul" || rec.type === "choice" || rec.type === "score" ? rec.type : undefined;
  return { instructions: rec.instructions, criteria, type };
}

/** The API rejected this item payload — the only item-specific failure. */
const ITEM_LEVEL_STATUS = new Set([400, 413, 422]);

/**
 * Core withMapReduce is atomic: one bad item rejects the whole call. A
 * corpus run must not lose every answer over one bad item, so only a payload
 * rejection (400/413/422) counts as per-item; config, auth, rate-limit,
 * server, and network errors stay batch-level and keep the atomic behaviour.
 */
function isBatchLevelError(err: unknown): boolean {
  if (err instanceof JevError) {
    return err.status === undefined || !ITEM_LEVEL_STATUS.has(err.status);
  }
  return true;
}

interface ClassifyMapResult {
  perItem: Array<Record<string, Answer> | null>;
  reduced: Answer | null;
  failures: Array<{ index: number; error: string }>;
  reduceSkipped?: string;
}

/**
 * The same questions over every item, then an optional reduce — core
 * withMapReduce plus per-index attribution. The happy path is one request per
 * item; a batch rejected by one bad item is retried item by item so every
 * answer survives and each failure is named. The reduce digest needs every
 * answer, so any failure skips it (see reduceSkipped).
 */
async function classifyItems(
  config: JevConfig,
  items: readonly unknown[],
  questions: Questions,
  opts: { reduce?: MapReduceOptions["reduce"]; concurrency?: number },
): Promise<ClassifyMapResult> {
  try {
    const { perItem, reduced } = await withMapReduce(config, items, () => questions, {
      reduce: opts.reduce,
      concurrency: opts.concurrency,
    });
    return { perItem, reduced, failures: [] };
  } catch (err) {
    if (isBatchLevelError(err)) throw err;
    return await attributeItemFailures(config, items, questions, opts, err);
  }
}

async function attributeItemFailures(
  config: JevConfig,
  items: readonly unknown[],
  questions: Questions,
  opts: { reduce?: MapReduceOptions["reduce"]; concurrency?: number },
  batchErr: unknown,
): Promise<ClassifyMapResult> {
  const perItem: Array<Record<string, Answer> | null> = new Array(items.length).fill(null);
  const failures: Array<{ index: number; error: string }> = [];
  const concurrency = Math.max(1, Math.floor(opts.concurrency ?? 4));
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      try {
        const one = await withMapReduce(config, [items[index]], () => questions, {
          concurrency: 1,
        });
        perItem[index] = one.perItem[0] ?? {};
      } catch (itemErr) {
        if (isBatchLevelError(itemErr)) throw itemErr;
        failures.push({
          index,
          error: itemErr instanceof Error ? itemErr.message : String(itemErr),
        });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  failures.sort((a, b) => a.index - b.index);
  const skipped =
    opts.reduce === undefined
      ? undefined
      : failures.length > 0
        ? failures.length +
          " of " +
          items.length +
          " item(s) failed, so the reduce digest would be incomplete"
        : "reduce failed: " + (batchErr instanceof Error ? batchErr.message : String(batchErr));
  return { perItem, reduced: null, failures, reduceSkipped: skipped };
}

async function classifyCommand(argv: string[], io: CliIo): Promise<number> {
  const args = parseClassifyArgs(argv);
  if (args.help) {
    io.out(USAGE + "\n");
    return 0;
  }
  if (args.items === undefined) {
    throw new UsageError("--items is required: a JSONL corpus file, or '-' for stdin");
  }
  if (args.questions === undefined) {
    throw new UsageError("--questions is required: a question map, or one question object");
  }
  if (args.items === "-" && args.questions === "-") {
    throw new UsageError("--items and --questions cannot both read stdin");
  }

  const stdin = io.stdin ?? "";
  const items = parseJsonl(await readTextInput(args.items, stdin, "--items"), "--items");
  if (items.length === 0) throw new UsageError("--items: the corpus is empty");
  const questions = asQuestions(
    await resolveJsonInput(args.questions, stdin, "--questions"),
    "--questions",
  );
  const reduce =
    args.reduce === undefined
      ? undefined
      : asReduceQuestion(await resolveJsonInput(args.reduce, stdin, "--reduce"), "--reduce");

  const outcome = await classifyItems(buildConfig(args, io), items, questions, {
    reduce,
    concurrency: args.concurrency,
  });

  const lines: string[] = [];
  for (let i = 0; i < items.length; i++) {
    const failure = outcome.failures.find((f) => f.index === i);
    if (failure) lines.push(JSON.stringify({ index: i, error: failure.error }));
    else lines.push(JSON.stringify({ index: i, answers: outcome.perItem[i] ?? {} }));
  }
  if (reduce !== undefined && outcome.reduceSkipped === undefined) {
    lines.push(JSON.stringify({ reduced: outcome.reduced }));
  }

  if (args.out !== undefined) await writeFile(args.out, lines.join("\n") + "\n", "utf8");
  else for (const line of lines) io.out(line + "\n");

  for (const failure of outcome.failures) {
    io.err(`item ${failure.index}: ${failure.error}\n`);
  }
  if (outcome.reduceSkipped !== undefined) {
    io.err(`reduce skipped: ${outcome.reduceSkipped}\n`);
  } else if (outcome.failures.length > 0) {
    io.err(`${outcome.failures.length} of ${items.length} item(s) failed\n`);
  }
  return outcome.failures.length > 0 || outcome.reduceSkipped !== undefined ? 1 : 0;
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
    io.out(
      "jev eval — evaluate Jev questions against a labeled dataset\n\nDelegates to jev-eval.\n\n",
    );
    return runEvalCli(["--help"], { out: io.out, err: io.err });
  }
  return runEvalCli(argv, { out: io.out, err: io.err });
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
      case "ask":
        return await askCommand(rest, sinks);
      case "models":
        return await modelsCommand(rest, sinks);
      case "classify":
        return await classifyCommand(rest, sinks);
      case "eval":
        return await evalCommand(rest, sinks);
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
