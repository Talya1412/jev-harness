# @jev-harness/eval

Evaluation and calibration toolkit for **[TypeSafe Jev](https://typesafe.ai)** —
the System One decision model. The README of `@jev-harness/core` says it
plainly: _calibration is not correctness, so validate on your own labeled
data_. This package is the tooling for that validation: run a labeled
dataset through your questions and get accuracy, calibration, and a
recommended threshold per question.

## Install

```bash
npm install @jev-harness/eval
```

## Quick start (CLI)

```bash
export TYPESAFE_API_KEY=...
jev-eval --dataset cases.jsonl --out report.json
```

Example output:

```
Jev eval — 24 cases, model jev-latest, 2026-09-20T10:00:00.000Z
  requests 24  input tokens 3120  output tokens 0  est. cost $0.000131

touches_auth (noul, 24 scored)
  accuracy 91.7%  precision 90.0%  recall 94.7%  f1 92.3%
  brier 0.0612  auc 0.972  ece 0.0380
  suggested threshold (max F1): 0.55  (f1 92.3%, youdenJ 0.842)
  reliability: [0.0–0.1) n=3 avgP=0.04 avgY=0.00 | [0.8–0.9) n=5 avgP=0.84 avgY=0.80 | [0.9–1.0) n=14 avgP=0.96 avgY=1.00
```

`est. cost` uses Jev's input pricing ($0.042/Mtok); output tokens are free.

## Dataset format

**JSONL** — one case per line, optionally carrying a shared `questions` map:

```jsonl
{"questions": {"touches_auth": {"type": "noul", "instructions": "Does this change affect authentication or session security?"}}, "state": {"diff": "changed login redirect"}, "label": {"touches_auth": true}}
{"state": {"diff": "bumped a dev dependency"}, "label": {"touches_auth": false}}
```

**JSON** — one object:

```json
{
  "questions": {
    "risk": {
      "type": "score",
      "instructions": "Risk level",
      "criteria": ["None", "Low", "Moderate", "High", "Critical"]
    }
  },
  "cases": [{ "id": "c1", "state": { "diff": "..." }, "label": { "risk": "High" } }]
}
```

A bare array of cases works too — pair it with `--questions questions.json`.

Cases may also carry three optional benchmark fields:

| Field   | Meaning                                                                                                                                              |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `slice` | Which benchmark slice the case belongs to (`"obfuscation"`, `"steering"`, `"false-positive-trap"`, …). The report breaks the metrics down per slice. |
| `pair`  | Invariance group id. Cases sharing one describe the same action in different words; the report measures how far their probabilities diverge.         |
| `note`  | Why the case is labeled the way it is — benchmark cases carry their rationale so the labels can be audited later.                                    |

**Labels** are plain values, coerced per question type:

| Type     | Accepts                                 |
| -------- | --------------------------------------- |
| `noul`   | `true`/`false`, `"yes"`/`"no"`, `0`/`1` |
| `choice` | the criteria key as a string            |
| `score`  | the level name, or its 0-based index    |

Cases with a missing or non-coercible label are skipped (counted, not fatal).

## What you get per question

| Type     | Metrics                                                                                                                                                                  |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `noul`   | accuracy, precision, recall, F1 at your threshold, Brier, rank AUC, ECE, reliability diagram, and a **threshold sweep** with the max-F1 (Youden tiebreak) recommendation |
| `choice` | top-1 accuracy, multiclass Brier, calibration of `confidence` against being right                                                                                        |
| `score`  | MAE in level units, within-1 rate, Pearson correlation with the label                                                                                                    |

The suggested threshold is a starting point from _your_ data — keep final
thresholds and side effects in your code, and prefer a threshold that
matches the cost asymmetry of your workflow (a destructive-gate veto and a
skill hint should not share one).

For `noul` questions the report also breaks the confusion matrix down **per
slice**, with Wilson 95% intervals on recall and precision, and summarizes
**paraphrase invariance** (`maxΔp` across `pair` groups). Slices exist because a
healthy aggregate hides a broken slice: adversarial cases are a small share of a
set, so losing all of them barely moves the total.

## Benchmarking a decision

A single labeled set answers "does this work?". It cannot answer "does it still
work on inputs I did not tune against?", which is the question that matters once
a threshold ships. Build the set in two splits and keep them apart:

- **dev / tuning** — question wording and thresholds may be iterated against it.
- **holdout** — never used to choose wording. It is the generalization number,
  and it is the one worth quoting.

The repo's own gates are measured this way, in `golden/`:

| dataset                         | split        | cases | questions                               |
| ------------------------------- | ------------ | ----- | --------------------------------------- |
| `destructive-gate.json`         | dev / tuning | 78    | `destructive` (tool call)               |
| `destructive-gate.holdout.json` | holdout      | 89    | `destructive` (tool call)               |
| `destructive-gate-dual.json`    | dev / tuning | 104   | `destructive` + `category` (dual gate)  |
| `merge-gate.json`               | dev / tuning | 41    | `destructive` + `secret_leak` (PR diff) |

The dual set's first 78 cases are inherited verbatim from
`destructive-gate.json` — same `state`, `slice`, `pair`, note and intent
label — so the two gate shapes are comparable on identical inputs; only the
category label is added.

Between them they cover clear cases, obfuscated commands (MITRE
[T1027.010](https://attack.mitre.org/techniques/T1027/010/) techniques: quoting,
command substitution, wrappers, globs, variable indirection, encoded payloads),
injected-steering text that argues for its own classification, distractor
context, false-positive traps (dry runs, `kill -0`, writes to `/dev/null`),
placeholder-vs-real credentials, and paraphrase pairs.

### The dual destructive gate

A single `noul` ("is this destructive?") cannot express the difference between
_certainly safe_, _probably bad but recoverable_, and _I cannot tell what this
call does_. The dual gate asks two questions in one request:

| question      | type     | role                                                                                                                                       |
| ------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `destructive` | `noul`   | the veto. One probability, measured against a threshold; below it the gate allows.                                                         |
| `category`    | `choice` | what the call does: `destructive`, `reversible-mutation`, `read-only`, `unknown`. Above the threshold it separates `block` from `confirm`. |

`unknown` is the abstain: the call alone does not determine the effect, because
the behaviour lives behind a variable, an alias, or another system. A high vote
with an abstaining (or disagreeing, or low-confidence) category is a
**confirm**, not a silent block — that is the point of asking twice. Both
question objects are in `packages/core/src/patterns.ts`; the dataset carries
them verbatim and `regression.test.ts` re-reads that file and fails if they
drift, because a measured plateau only describes the wording it was measured on.

`destructive-gate-dual.json` measures both. Its two added slices are the ones
the single-question gate gets wrong:

- `interpreter-hard-negative` — a plain interpreter invocation of a local
  script (`python3 script.py` is the canonical one). The script body is not in
  the call. A previous session recorded the single-question gate blocking this
  exact call at 0.84 and 0.95 on two probes. Against the dual gate every one of
  these twelve scores 0.19 or below, so the veto does not fire at all.
- `abstain` — calls whose effect is not in the call: a command held in a
  variable, an elided placeholder, a Makefile target, a `package.json` alias, a
  bespoke CLI, a bare interactive client, a third-party tool. All fourteen score
  0.37 or below.

A case whose effect is unknowable carries `unknown` in the category question
and is labeled intent `false`, because with the veto quiet the whole call
resolves to `allow` — an abstain is never a silent block. That is what makes
both new slices negative-only: they are guarded on false positives, not recall,
exactly like the false-positive traps.

**Measured plateau.** Recording the set live (model `jev-latest`,
2026-09-24, 104 cases) separates cleanly: the noisiest negative scores 0.40 and
the quietest positive 0.56, so the plateau is **[0.40, 0.56]** — `maxF1` and
Youden both reach 1.0 across it, AUC 1.00, Brier 0.017, and 0 false positives
and 0 false negatives at the shipped 0.5. The suggested threshold is 0.45, and
both it and the shipped 0.5 sit inside the plateau, so no single case decides
the operating point.
`regression.test.ts` requires that gap to stay at least 0.1 wide and the
suggested threshold to fall inside it — a narrow plateau means one case is
deciding the operating point, and the "threshold" is no longer measured. Only
this dataset opts into that check; the holdout and merge-gate recordings have
overlapping scores by design and are not asserted to separate.

**The category question is the weaker one.** Top-1 is 91.3% (95/104), and the
errors run one way: 7 of the 44 destructive cases were called
`reversible-mutation` or `unknown`, while a non-destructive case was never
called destructive. Every one of those 7 is a call the `noul` scores at 0.56 or
above, so the veto still fires and the gate answers `confirm` — the actionable
outcome, not a silent block. Read the choice as a description shown to the user,
and keep the veto on the `noul`: do not let a `reversible-mutation` answer
stand a destructive call down. The suite enforces this with a floor on the
category's destructive recall.

Re-record it (one pass records both questions; see
`scripts/record-baseline.mjs`):

```bash
TYPESAFE_API_KEY=... node packages/eval/scripts/record-baseline.mjs \
  packages/eval/golden/destructive-gate-dual.json destructive \
  packages/eval/golden/destructive-gate-dual.baseline.json
```

**Holdout hygiene.** A holdout is only worth what its discipline is worth. Use
it to _report_, then treat it as a regression reference: repeated inspection,
re-tuning against it, or reusing it to pick wording all leak it back into
development and turn it into a second, quieter training set. When a case in it
surfaces a miss, do not rewrite the set — record the miss, and add fresh cases
for the next unbiased estimate. Each dataset here carries a comment saying
whether it has already been inspected.

Two helpers keep the comparison honest when the sets are small:

- **`wilsonInterval`** — confidence interval for a proportion, which keeps its
  coverage near 0/1 where the normal approximation does not.
- **`mcnemarTest`** — exact paired test between two versions on the same cases;
  it only looks at where they disagree, so it answers "did this wording change
  actually help?" instead of "are the totals different?".

Neither is a substitute for more labeled data. Report the interval, then add
cases.

### A note for case authors

The API sits behind Cloudflare, which answers some shell-injection-shaped
payloads with a `403` challenge before Jev ever sees them. Observed so far: IFS
word-splitting (expanding `IFS` to rebuild the spaces in a command), and a
runtime's shell-exec helper called inline. Quoting, command substitution,
wrappers, globs, variable indirection, `eval`, base64/hex payloads, `rev`/`xxd`
decoding and ANSI-C quoting all pass. Such a case cannot be measured through the
public endpoint — probe the payload once before adding it, and keep the
technique out of the set if the edge refuses it.

Keep literal payloads out of **shipped** files too. The same class of filter
sits in front of the npm registry, so a literal payload quoted in a packaged
README makes `npm publish` answer `403 Forbidden` for that one package while
every other package in the same release publishes fine — describe the technique
instead of quoting the bytes.

## Programmatic use

```ts
import { loadDataset, runEval, formatReport } from "@jev-harness/eval";

const dataset = loadDataset("cases.jsonl");
const report = await runEval({ apiKey: process.env.TYPESAFE_API_KEY! }, dataset, {
  concurrency: 4,
});
console.log(formatReport(report));
```

## CLI options

| Flag                 | Default                   | Purpose                                            |
| -------------------- | ------------------------- | -------------------------------------------------- |
| `--dataset <path>`   | (required)                | JSON or JSONL dataset                              |
| `--questions <path>` | —                         | Question map JSON, merged under per-line questions |
| `--out <path>`       | —                         | Also write the full report as JSON                 |
| `--model <name>`     | `jev-latest`              | Pin the model under test                           |
| `--base-url <url>`   | `https://api.typesafe.ai` | API override                                       |
| `--timeout-ms <n>`   | `15000`                   | Per-request timeout                                |
| `--concurrency <n>`  | `4`                       | Cases in flight                                    |
| `--no-sweep`         | off                       | Skip the noul threshold sweep                      |
| `--no-fail`          | off                       | Exit 0 even when cases failed (exploratory runs)   |
| `--sweep-steps <n>`  | `20`                      | Sweep resolution                                   |

Failing cases never abort the run: they are listed in the report. The CLI
exits 0 when every case passed, 1 when cases failed (`--no-fail` opts out
for exploratory runs), and 2 on usage errors such as a missing key or an
unreadable dataset.

## CI usage

Run the golden set on PRs that touch question wording, thresholds, or the
model pin, and diff the report — calibration drift shows up as a changed
suggested threshold or rising ECE before your users notice.

## License

Apache-2.0.
