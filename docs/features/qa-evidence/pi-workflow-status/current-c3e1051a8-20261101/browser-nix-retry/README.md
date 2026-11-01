# Documented Nix recovery: BLOCKED

One browser retry ran on main `c3e1051a8cba78a2d6ee195480058ed36ad14c8a`, 2026-11-01 approximately 03:16–03:18 UTC. `docs/development.md:9–38` documents the Nix shell's browser libraries and fonts. It resolved the original missing `libglib-2.0.so.0` failure without installation or a different launcher. The original failure artifacts remain in the parent directory.

Exact command from the repository root:

```bash
nix develop -c env \
  PASEO_PI_BINARY=/nix/store/v86wfk7n5acr75lbhd5aa2qsfbf615rb-pi-coding-agent-1.4.0/bin/pi \
  PASEO_PI_SUBAGENTS_PACKAGE=/nix/store/spwn6yyrml8by6wpw6l4a0f0jhybs9m9-pi-subagents-0.84.0/lib/node_modules/pi-subagents \
  npm run test:e2e:real --workspace=@getpaseo/app -- \
  e2e/browser/pi-workflow-subagent-tree.real.spec.ts --workers=1 \
  --output=/home/sinkerine/dev/paseo/docs/features/qa-evidence/pi-workflow-status/current-c3e1051a8-20261101/browser-nix-retry/browser-results
```

Result: **exit 1; 1 passed, 1 failed (1.1 minutes)**. [Raw output](browser-journey.txt) and [exit status](browser-journey.exit) are preserved. Pi **1.4.0** and pi-subagents **0.84.0** passed the fixture's explicit version assertions. The Nix shell provides Node **v22.22.1**; [nix-runtime.json](nix-runtime.json) records a read-only post-run probe of Node, `LD_LIBRARY_PATH`, and `FONTCONFIG_FILE`. [trace-runtime.json](trace-runtime.json) records Playwright **1.58.2** and the Chromium **145.0.7632.6** user agent from the failure trace.

The wide/compact pane test passed in **23.9 seconds**. Its screenshots are under `browser-results/pi-workflow-subagent-tree.-75d17-on-wide-and-compact-layouts-real-provider/`:

- `workflow-pane-wide.png`
- `workflow-run-wide.png`
- `workflow-pane-compact.png`
- `workflow-run-compact.png`

The tree disclosure/settlement/reload test failed in **16.8 seconds** at `pi-workflow-subagent-tree.real.spec.ts:74` (`expectRunningTree`, called at line 189). It expected Workflow, T1, T2, Implement T2, and Review T2 rows while running; it received only `Workflow2 of 2 groups done`. The call log shows the tree changing from three/four rows to one during the assertion. Its failure screenshot, `error-context.md`, `video.webm`, and `trace.zip` are under `browser-results/pi-workflow-subagent-tree.-7e442--tools-settles-and-rebuilds-real-provider/`. [browser-console.txt](browser-console.txt) is extracted unchanged from that trace's attached console resource. The failure trace passed ZIP integrity validation.

Source evidence identifies a likely harness gate-state defect. `piWorkflow` is worker-scoped (`pi-workflow-subagent-tree.real.spec.ts:17–28`), so the tests share the gate. The first test removes the gate at line 168, then unconditionally recreates it through `releasePiWorkflow` in `finally` at line 171. That helper writes the gate file (`helpers/pi-workflow.ts:114–115`). The second test launches at lines 184–189 without removing the gate. The scripted review shell therefore sees an open gate and can finish before the running-tree assertion. This explains the observed early completion; no harness repair or further retry was attempted. The remainder of the second journey has not passed acceptance.

Cleanup: the harness stopped worker daemon **36981** and Metro **40983**. [cleanup.json](cleanup.json) confirms their ports had no listeners and the worker home was removed. The runtime fixture's process cleanup assertion passed. The Nix shell left only caches in its dedicated `/tmp/nix-shell.uDIhsQ` root; after verifying no matching processes, this run removed that root and recorded its entries. Production port **6767** retained PID **813116** in both listener snapshots. No daemon/unit tests were rerun, and no feature/harness edits, commits, or staging occurred.

Final checks run from repository root, with raw output and exits under this directory:

```bash
npm run format:files -- docs/features/qa-evidence/pi-workflow-status/current-c3e1051a8-20261101/README.md docs/features/qa-evidence/pi-workflow-status/current-c3e1051a8-20261101/commands.md docs/features/qa-evidence/pi-workflow-status/current-c3e1051a8-20261101/browser-nix-retry/README.md docs/features/qa-evidence/pi-workflow-status/current-c3e1051a8-20261101/browser-nix-retry/cleanup.json docs/features/qa-evidence/pi-workflow-status/current-c3e1051a8-20261101/browser-nix-retry/nix-runtime.json docs/features/qa-evidence/pi-workflow-status/current-c3e1051a8-20261101/browser-nix-retry/trace-runtime.json
npm run format:check:files -- <same six evidence files>
npm run typecheck
npm run lint
git diff --check
git diff --cached --exit-code
```

Repair and verification of the gate-state isolation issue require a separate task. Current codemode launch remains unsupported because `subagent` is model-only.
