# Third-party notices

This project is licensed under Apache-2.0 (see [LICENSE](LICENSE)). It adapts
design patterns, constants, and algorithms from the following MIT-licensed
projects. No source code is copied verbatim except where noted; the pattern
borrowed and the file it influenced are listed for each.

## fast-jev-compaction

- Source: https://github.com/tamaratran/fast-jev-compaction
- License: MIT
- Borrowed: the verbatim-compaction algorithm — pairing each tool call with its
  result, asking two `noul` questions per call ("should the call stay", "should
  the result stay verbatim"), the `keepThreshold` / `preserveRecentMessages` /
  `truncateHeadChars` option set, the staged state-fitting order, and the
  decision mapping (keep both / keep call only / drop both) with a truncation
  note instead of silent deletion.
- Used in: `packages/omp/src/extension.ts` (`session_before_compact` handler),
  `packages/pi/src/extension.ts`.

## jerryfane/omp-jev-compaction

- Source: https://github.com/jerryfane/omp-jev-compaction
- License: MIT
- Borrowed: the OMP integration specifics — that `session_before_compact`
  receives `{ preparation: { messagesToSummarize, turnPrefixMessages,
firstKeptEntryId, tokensBefore } }` and must return a `CompactionResult`,
  the lowered `keepThreshold` default of 0.2 (upstream's 0.5 is
  non-discriminating on real sessions), and the fail-open-to-native-compaction
  fallback.
- Used in: `packages/omp/src/extension.ts`.

## browser-use/jev-ultrafast

- Source: https://github.com/browser-use/jev-ultrafast
- License: MIT
- Borrowed: the browser action-selection shape — a numbered element table as
  `state`, one `operation` choice over CLICK / TYPE_TEXT / SELECT / SCROLL_* /
  WAIT / DONE / BLOCKED, one `<operation>_target` choice per available
  operation in a single fan-out request, and the rule that code validates the
  chosen index against the live snapshot rather than the model executing it.
- Used in: `packages/core/src/patterns.ts` (`chooseBrowserAction`).

## TypeSafe agent skill

- Source: https://github.com/typesafe-ai/skills
- License: MIT
- Borrowed: the question-design guidance reflected in the primitive validation
  rules (one narrow judgment per question; a `choice` needs at least two
  criteria; a `score` needs at least two ordered levels) and the
  "confidence is distribution concentration, not correctness" caveat carried in
  the READMEs.

## API contract

The System One HTTP contract (`POST /v1/systemone`, the `noul` / `choice` /
`score` request shapes and their response fields) is defined by TypeSafe's
public documentation at https://docs.typesafe.ai and is not claimed as original
work here.
