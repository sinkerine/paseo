# Pi workflow status verification

Verified on Linux with real Pi 1.0.4, pi-subagents 0.71.0, the branch daemon and Chromium web app on 2026-10-31. No app or protocol changes.

The isolated daemon used `.dev/pi-workflow-e2e/paseo-home`, port 6768, and server `srv_jwW8orwEVOvs`. Expo used port 8081. The production daemon on 6767 was untouched. Two scratch Git repositories and copied Pi configuration under `.dev/pi-workflow-e2e` isolated workflow execution and agent discovery. Copied auth/model configuration is ignored and excluded from this evidence.

## Results

| Journey                            | Observed result                                                                                         | Evidence                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Direct async workflow, idle parent | Parent idle, workflow and first child running; workspace running                                        | `direct-running.png`, observations `direct-idle-running.json` |
| Direct step transition             | First completed, second running, workspace running                                                      | `direct-mid.png`, observations `direct-mid.json`              |
| Direct completion                  | All three rows completed; workspace done after attention cleared                                        | `direct-complete.png`                                         |
| Codemode async workflow            | One workflow inventory, nested IDs linked to outer codemode tool call; idle parent workspace running    | `codemode-running.png`                                        |
| Codemode transition/completion     | First completed while second running; all settled on completion                                         | `codemode-mid.png`, `codemode-complete.png`                   |
| Stop                               | Real Pi stop tool cancels workflow and child                                                            | `stop-running.png`, `stop-settled.png`                        |
| Failure                            | Second step with nonexistent agent fails workflow; its rows stop running                                | `failure-settled.png`                                         |
| Ordinary async single              | Running then completed                                                                                  | `single-running.png`, `single-complete.png`                   |
| Foreground parallel workflow       | Two short child tasks complete                                                                          | `parallel-complete.png`                                       |
| Dev daemon restart and reopen      | Interrupted direct workflows replay canceled; no running rows remain                                    | `reload-settled.png`, `reload-retry.log`                      |
| Isolation                          | Second workspace has no provider subagents throughout, remains inactive after initial attention cleared | Screenshots and `observations.json`                           |

The active indicator uses blue in this theme. Its rendered test id is `workspace-status-indicator-running`; the inactive comparison uses `workspace-status-indicator-done`. Finished foreground turns can produce attention independently of background activity, so attention was explicitly cleared before final inactive captures.

The first stop harness attempt tried reading the `.active-runs` bookkeeping directory as a run and exited before stopping its workflow. The harness was corrected to enumerate UUID run directories. Its leftover workflow remained legitimately active during some later screenshots and settled before restart. `stop-settled` proves cancellation of the requested run, rather than inactivity of every concurrent run. The first restart command supplied both `--host` and `--home` and was rejected without restarting; the successful retry selected only the isolated home. These were scratch harness fixes, with no feature repair.

## Commands and checks

Run from the feature worktree:

```sh
npm run dev
npm run dev:app
nix develop --command node .dev/pi-workflow-e2e/browser.mjs
nix develop --command node --import tsx .dev/pi-workflow-e2e/journey.mts
node --import tsx .dev/pi-workflow-e2e/reload.mts
npm run typecheck
npm run lint
npm run format:check
```

Daemon and app launch environments set `PASEO_HOME` to the isolated home. Agent launch environments set `PI_CODING_AGENT_DIR` and `PI_SUBAGENTS_TEMP_ROOT` to scratch paths. Scripts, raw daemon/RPC logs and full observations remain under `.dev/pi-workflow-e2e`; committed observations retain lifecycle metadata without transcripts or host paths.

Targeted tests, from `packages/server`, all passed after the final feature edit:

```sh
npx vitest run src/server/agent/providers/pi/extensions/pi-subagents/index.test.ts --bail=1
# 29 passed
npx vitest run src/server/agent/providers/pi/extensions/pi-subagents/async-runs.test.ts --bail=1
# 129 passed
npx vitest run src/server/workspace-directory.test.ts --bail=1
# 27 passed
```

Full typecheck, lint and formatting checks passed. No full test suite ran locally. Captured logs accompany this report.

## Coverage limits

Linux daemon and Chromium web were exercised. Windows path selection has deterministic identity-injection tests, but no Windows host run. macOS, Electron, iOS and Android were not exercised; the implementation is server-only. Codemode replay cannot discover a custom Pi-only temp-root override after restart when the bridge mapping is gone; such rows are omitted without phantom activity. Detached async children inside workflows remain outside the workflow's ownership and are shown completed, as approved in the plan.
