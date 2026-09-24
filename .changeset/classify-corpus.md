---
"@jev-harness/mcp": minor
"@jev-harness/cli": minor
"@jev-harness/pi": minor
---

Expose core map-reduce as `jev_classify`: the same typed questions over a whole corpus.

Core has shipped `withMapReduce` with no consumer: the dominant real-world Jev workload
(score 100k posts, bucket 24k rows, classify 1,018 papers) was impossible from any adapter,
so a caller with 1,000 items had to loop by hand and give up the batching, capping and
reduce. The three corpus-facing surfaces now expose it:

- `jev_classify` on the MCP server: `items` (strings or JSON), `questions`, optional `reduce`
  and `concurrency`. Returns `{ perItem, reduced, failures, reduceSkipped, usage }`.
- `jev classify` in the CLI: JSONL corpus in (`--items`), one JSON result line per item out,
  `--questions` / `--reduce` / `--out` / `--concurrency`. Partial failures name the failing
  indices on stderr while every success is still emitted (exit 1).
- `jev_classify` in the Pi extension, with the same semantics.

The reduce step judges a capped digest of the per-item verdicts (200 items / 4000 chars in
core), never the corpus. Core map-reduce is atomic, so a payload rejection (400/413/422) is
retried item by item to attribute the failure; batch-level failures (missing key, auth, rate
limit, network) keep failing the whole call.

Cost is one request per item: `items x questions` judgments, plus one reduce call.
