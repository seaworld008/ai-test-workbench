# Diff-Impact Fast Feedback Prompt

> [简体中文 (默认)](./diff-impact-gate.md)

After completing a code change in `<repo>`, run targeted regression feedback:

```bash
npx ai-test-workbench@6.1.0 impact --target "<repo>" --base origin/main
npx ai-test-workbench@6.1.0 run --target "<repo>" --suite impact --base origin/main --audit
```

Remember:
- `impact` narrows local and PR feedback loops when changed files map cleanly via `qa/impact-map.json` or spec dependencies (`--only-changed`).
- Whenever shared infrastructure, router/auth files, or unmapped source files change, `impact` intentionally falls back to the full suite.
- Merge, nightly, and release gates must always run `--suite all --audit`.
