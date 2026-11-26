# ADR-0006: Dual-Target 5-Checkpoint Differential Parity Oracle (`aitest_parity`) & Zero-Plaintext Shape Fingerprints

> [简体中文 (默认)](./0006-differential-parity-oracle-and-shape-fingerprints.md) · [English README](../../README.en.md) · [Architecture](../../ARCHITECTURE.en.md) · [Evolution Roadmap](../review/v6.4-differential-verification-and-memory-loop-roadmap.en.md)

- **Status**: Accepted (Round 1 kernel, CLI, and MCP surface implemented)
- **Date**: `2026-11-26`

---

## 1. Context & Problem Statement

During cross-language rewrites, framework migrations, and streaming AI service evolution, synthetic Playwright suites and static AST gates alone leave four structural blind spots:

1. **Static AST blindness to same-tier `S5 -> S5` literal catering**: When an agent rewrites an expected literal from `409` to `201` or `"$49.00"` to `"$0.00"` to match a buggy candidate implementation, assertion strength remains `S5`; static syntax inspection cannot substitute for a live Baseline behavioral oracle.
2. **Combinatorial edge cases & byte-level encoding divergence**: Synthetic specs miss long-tail traffic combinations (such as Python `json.dumps` ASCII `\uXXXX` emoji escaping vs Rust raw UTF-8 bytes), and streaming SSE endpoints lacked `text` / `thinking` / `toolCalls` / `usage` reassembly and `TTFT` SLO gates.
3. **Failure triage storms & payload privacy boundaries**: Shared serialization or auth defects trigger dozens of simultaneous failures whose flat logs overwhelm agent context, while customer/production traffic payloads must never leak in plaintext to agent prompts.
4. **SUT mocking vs external non-deterministic upstream replay**: Allowing `route.fulfill(2xx)` against the system under test enables fake-green fabrication, yet external LLM/RPC dependencies require deterministic single-source replay across both Baseline and Candidate targets.

---

## 2. Decision

1. **5-Checkpoint Differential Parity Oracle (`src/kernel/diff-oracle.mjs` + `src/parity/`)**:
   - Standardizes five deterministic checkpoints: `CP1-Status-Headers` (exact HTTP status equality and key headers), `CP2-Body-Shape-And-Value` (key-order-independent recursive JSON diff plus optional `strictByteEscape` raw token comparison), `CP3-Stream-Frames` (zero-dep `src/core/stream-sse.mjs` reassembly for Anthropic Messages SSE and OpenAI SSE, mid-stream error detection, and clean termination checks), `CP4-DOM-ARIA-And-Runtime` (dual ARIA snapshots and newly introduced candidate `pageErrors`/`serverErrors`), and `CP5-Perf-Ratio` (latency and `TTFT` ratio regression warnings).
   - **No blind auto-denoising**: Never runs the baseline twice to auto-ignore volatile fields. Deterministic stripping applies strictly to explicitly declared `normalizePaths` (`headers.date`, `headers.etag`, `headers.x-request-id`, `headers.traceparent`, plus governance-locked `aitest.config.json#parity.normalizePaths`).
2. **Zero-Plaintext Shape Fingerprints & Root-Cause Clustering (`computeShapeFingerprint` + `src/diagnose/{fingerprint,cluster}.mjs`)**:
   - Computes deterministic SHA-256 truncated fingerprints `fp_<12hex>` strictly from structural geometry: `{ checkpoint, routePattern, pieceOrJsonPath, firstDiffByteOffset, baselineByteLen, candidateByteLen, diffKind, featureCohort }`.
   - Under `--privacy-mode shape-only`, outputs and reports forcibly erase all business payload previews (`baselinePreview: null`, `candidatePreview: null`), enabling zero-plaintext debugging. `aitest_diagnose` emits deduplicated `clusters[]`, fastest `minimalReproducerSpec`, and cross-run masking-cascade links (`unmaskedAfterFixOf`).
3. **Offline Sanitized Traffic Corpus & Multi-Sample Union Schema (`src/corpus/` + `src/explore/schema-inferrer.mjs`)**:
   - Preserves strict production isolation by importing offline HAR 1.2, JSONL, or OTel HTTP Span files only, scrubbing secrets, stripping external origins to relative paths, filtering high-risk delete/payment paths by default, and tagging zero-plaintext `featureCohort` labels.
   - Upgrades schema inference from single-sample `val[0]` to multi-sample union inference across all captures per endpoint (sampling up to 50 array elements, preserving `items` when merging empty arrays, tracking `nullable` and heterogeneous `oneOf`, and flagging emoji/Unicode encoding traits).
4. **Governance-Locked Upstream Replay Cassettes & Streaming `TTFT` Gate (`src/replay/cassette.mjs` + `src/perf/streaming.mjs`)**:
   - Adds `corpus/**` and `fixtures/upstream-cassettes/**` to `DEFAULT_CONFIG_PROTECTED_GLOBS` so files created there are sealed by `.aitest/governance.lock` and require human CLI `governance approve`.
   - Refines `AITEST-G114` to keep blocking 100% of relative, `TEST_BASE_URL`, and loopback `route.fulfill(2xx)` mocks while permitting explicit external hosts declared in `replayAllowedUpstreamHosts` (forbidding loopback and wildcards) when not stubbing asserted status codes.
   - Extends `perf` (`--mode sse`, `--sse-endpoint`) and `perf-budget.json#streaming` with `ttftMedianMs`, `ttftP95Ms`, `streamTotalP95Ms`, and clean-termination enforcement.

---

## 3. MCP Tool Surface & CLI Boundaries (`16 -> 17`)

Following [ADR-0005](./0005-mcp-surface-outcome-and-config.en.md)'s conservative surface discipline:

1. Adds exactly **1** new canonical MCP tool — **`aitest_parity`** (bringing the canonical registry to `17` tools) — while folding related capabilities into `aitest_verify_change` (`mode="parity"`, `baselineUrl`), `aitest_diagnose` (`clusters[]`), and `aitest_perf` (`mode="sse"`, `sseEndpoint`).
2. Keeps offline traffic corpus import as local CLI command `corpus` writing into governance-locked `qa/corpus/sanitized-requests.jsonl` so human approval boundaries remain intact.
3. Enforces zero third-party runtime dependencies, acyclic 4-layer architecture, strict `checkJs` type safety, `<= 435` LOC per `src/**/*.mjs` module, and deterministic vendor mirroring of `src/kernel/diff-oracle.mjs` + `src/core/stream-sse.mjs` via `npm run sync:vendor`.

---

## 4. Security Guardrails & Backward Compatibility

1. **Dual-Target Default-Deny Firewall**: Both `parity` and `verify-change --mode parity` run `evaluateTargetSafety` and 10-hop `maxRedirects: 0` egress validation independently on `baselineUrl` and `candidateUrl`; either hitting production or an unauthorized host fails closed with `outcome: "blocked"` (exit code `2`).
2. **100% Backward Compatible**: All new config sections (`parity`, `replayAllowedUpstreamHosts`, `perf-budget.json#streaming`) and payload fields (`clusters`, `paritySummary`, `sseBenchmark`) are purely additive and opt-in; existing projects retain identical default behavior.
