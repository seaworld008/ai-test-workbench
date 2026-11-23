## Summary / 变更说明

Describe what changed and why.

## Checklist / 提交前检查

- [ ] `npm test` passes (all unit & CLI integration tests)
- [ ] `npm run smoke` passes offline Chromium + 3-layer gate
- [ ] `npm run demo:verify` passes full Smart Campus E2E + API + concurrency check
- [ ] `npm pack --dry-run` contains no `node_modules/`, `.env`, or `reports/`
- [ ] No real credentials, `.env` files, or `playwright/.auth/` states are committed
