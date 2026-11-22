---
"@jev-harness/core": patch
"@jev-harness/eval": patch
"@jev-harness/mcp": patch
---

Stop Jev requests promptly on caller cancellation, including during retry delays, and reject malformed answer maps. Report invalid evaluation options before sending requests and return a failure code when the report cannot be written.

Require the patched Model Context Protocol SDK.
