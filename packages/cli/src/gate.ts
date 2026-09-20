/**
 * Argument and state handling for the `jev-gate` CLI.
 *
 * Pure by design: parsing, stdin/diff/file resolution, and the exit-code policy
 * are decided here, while the single Jev call happens in the entrypoint. This
 * is what makes the gate usable in CI and as a subagent `gate` parameter —
 * and what makes its behaviour testable without a network.
 */
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

export const DEFAULT_THRESHOLD = 0.7;

/** Exit codes chosen so a shell can tell "failed the check" from "could not check". */
export const EXIT_PASS = 0;
export const EXIT_FAIL = 1;
export const EXIT_ERROR = 2;

export interface GateOptions {
  criteria: string;
  threshold: number;
  useDiff: boolean;
  file?: string;
  json: boolean;
  failOpen: boolean;
  model?: string;
  help: boolean;
}

export type ParseResult = { ok: true; options: GateOptions } | { ok: false; error: string };

function defaultOptions(): GateOptions {
  return {
    criteria: "",
    threshold: DEFAULT_THRESHOLD,
    useDiff: false,
    json: false,
    failOpen: false,
    help: false,
  };
}

/**
 * Parse argv (already sliced past `node script`). A bare non-flag argument is
 * treated as the criteria, so `jev-gate "tests pass"` works without `-c`.
 */
export function parseArgs(argv: readonly string[]): ParseResult {
  const options = defaultOptions();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "-h":
      case "--help":
        options.help = true;
        break;
      case "-c":
      case "--criteria":
        const raw = argv[++i];
                if (raw === undefined || raw.trim() === "") return { ok: false, error: arg + " requires a value" };
                options.criteria = raw;
        break;
      case "-p":
      case "--min-prob":
      case "--threshold": {
        const raw = argv[++i];
        if (raw === undefined) return { ok: false, error: arg + " requires a value" };
        if (raw.trim() === "") return { ok: false, error: arg + " requires a value" };
        const n = Number(raw);
        if (!Number.isFinite(n)) return { ok: false, error: arg + " expects a number, got '" + raw + "'" };
        options.threshold = n;
        break;
      }
      case "-d":
      case "--diff":
        options.useDiff = true;
        break;
      case "-f":
      case "--file": {
        const raw = argv[++i];
        if (raw === undefined) return { ok: false, error: arg + " requires a path" };
        options.file = raw;
        break;
      }
      case "--json":
        options.json = true;
        break;
      case "--fail-open":
        options.failOpen = true;
        break;
      case "-m":
      case "--model": {
        const raw = argv[++i];
        if (raw === undefined) return { ok: false, error: arg + " requires a model name" };
        options.model = raw;
        break;
      }
      default:
        if (arg.startsWith("-")) return { ok: false, error: "unknown option '" + arg + "'" };
        if (options.criteria === "") options.criteria = arg;
        break;
    }
  }
  return { ok: true, options };
}

export interface GateSources {
  /** Reads the git diff, or returns null when the repo has no changes to show. */
  diff: () => string | null;
  /** Reads from the process stdin (`fd 0`). */
  stdin: () => string;
  /** Reads a file by path. */
  file: (path: string) => string;
}

/** Default sources backed by the real process, child_process, and the filesystem. */
export function realSources(): GateSources {
  return {
    diff: () => {
      try {
        const head = execSync("git diff HEAD", { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        if (head.trim()) return head;
        const staged = execSync("git diff --cached", { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        return staged.trim() ? staged : null;
      } catch {
        return null;
      }
    },
    stdin: () => {
      try {
        return readFileSync(0, "utf8");
      } catch {
        return "";
      }
    },
    file: (path: string) => readFileSync(path, "utf8"),
  };
}

export type StateResult = { ok: true; text: string } | { ok: false; error: string };

/**
 * Resolve the text to judge, in precedence order: diff, then file, then stdin.
 * An unreadable file is an error rather than an empty state, so a typo cannot
 * silently pass a gate that had nothing to read.
 */
export function resolveState(options: GateOptions, sources: GateSources): StateResult {
  if (options.useDiff) {
    const diff = sources.diff();
    return diff === null
      ? { ok: true, text: "No git changes detected." }
      : { ok: true, text: diff };
  }
  if (options.file !== undefined) {
    try {
      return { ok: true, text: sources.file(options.file) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: "cannot read " + options.file + ": " + msg };
    }
  }
  const piped = sources.stdin();
  if (piped.trim() !== "") return { ok: true, text: piped };
  return { ok: true, text: "No state provided." };
}

/**
 * Exit code for a completed judgment. `probability` is P(criteria satisfied),
 * so the gate passes at or above the threshold.
 */
export function exitCodeFor(probability: number, threshold: number): number {
  return probability >= threshold ? EXIT_PASS : EXIT_FAIL;
}

export interface GateReport {
  passed: boolean;
  probability: number;
  threshold: number;
  criteria: string;
  elapsedMs: number;
  error?: string;
}

/** Render the report. `json` is machine-readable; the default is for a human. */
export function formatReport(report: GateReport, json: boolean): string {
  if (json) return JSON.stringify(report, null, 2);
  const verdict = report.passed ? "PASS" : "FAIL";
  const lines = [
    verdict + "  p=" + report.probability.toFixed(3) + "  threshold=" + report.threshold,
    "criteria: " + report.criteria,
    "elapsed: " + report.elapsedMs + "ms",
  ];
  if (report.error) lines.push("error: " + report.error);
  return lines.join("\n");
}

export const HELP = `Usage: jev-gate [options] [criteria]

Post-run gate check: one Jev judgment over a diff, file, or stdin.
Exits 0 when the judgment meets the threshold, 1 when it does not, 2 on error.

Options:
  -c, --criteria <text>     Acceptance criteria to check (or pass as a bare arg)
  -p, --threshold <num>     Minimum passing probability (default: ${DEFAULT_THRESHOLD})
  -d, --diff                Judge \`git diff HEAD\` (falls back to the staged diff)
  -f, --file <path>         Judge a file's contents
  -m, --model <model>       Override the Jev model
      --json                Print the report as JSON
      --fail-open           Exit 0 when Jev is unreachable or unconfigured
  -h, --help                Show this message

Examples:
  git diff | jev-gate -c "all exports are documented"
  jev-gate -c "tests pass and no new any types" --diff
  npm test 2>&1 | jev-gate "zero test failures" --json
`;
