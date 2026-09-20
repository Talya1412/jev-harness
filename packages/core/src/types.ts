/**
 * Core transport and primitive types for TypeSafe's Jev (System One) model.
 *
 * Jev takes a `state` (arbitrary JSON) plus typed `questions` and returns
 * calibrated probabilities rather than generated text. Everything in this
 * package is harness-agnostic: no framework imports, no globals.
 */

export const DEFAULT_BASE_URL = "https://api.typesafe.ai";
export const DEFAULT_MODEL = "jev-latest";

/** The three System One primitives. */
export type QuestionType = "noul" | "choice" | "score";

export interface NoulQuestion {
  type: "noul";
  /** The yes/no judgment, in plain words. */
  instructions: string;
  criteria?: string | Record<string, string>;
}

export interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  /** Map of option key -> description. At least two options. */
  criteria: Record<string, string>;
}

export interface ScoreQuestion {
  type: "score";
  instructions: string;
  /** Ordered levels, lowest first. At least two levels. */
  criteria: string[];
}

export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;
export type Questions = Record<string, Question>;

export interface NoulAnswer {
  type: "noul";
  /** Probability of yes, 0..1. */
  noul: number;
}

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface ScoreAnswer {
  type: "score";
  score: number;
  probabilities: Record<string, number>;
  confidence: number;
  legend?: Record<string, string>;
}

export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface JevResponse {
  model: string;
  answers: Record<string, Answer>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export interface JevConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  /** Per-request timeout in milliseconds. Default 15000. */
  timeoutMs?: number;
  /** Max attempts for transient failures (429/5xx/network). Default 3. */
  maxAttempts?: number;
  /** Injectable fetch, for tests and non-standard runtimes. */
  fetchImpl?: typeof fetch;
  /** Called on each retry with the attempt number and the error. */
  onRetry?: (attempt: number, error: Error) => void;
  /**
   * Redact likely secrets and direct identifiers (AWS keys, tokens, emails,
   * connection strings) from `state` before sending. `true` applies the
   * built-in patterns; pass a RedactOptions object to add extras. Default off.
   */
  redact?: boolean | import("./redact.js").RedactOptions;
}

export class JevError extends Error {
  readonly status?: number;
  readonly retryable: boolean;
  constructor(message: string, options: { status?: number; retryable?: boolean; cause?: unknown } = {}) {
    super(message);
    this.name = "JevError";
    this.status = options.status;
    this.retryable = options.retryable ?? false;
    if (options.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
  }
}
