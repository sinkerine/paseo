# Current-version acceptance: DONE

Run at 2026-11-01 03:12 UTC on main `c3e1051a8cba78a2d6ee195480058ed36ad14c8a`. Local runner timestamps use UTC−07:00. This evidence supplements the historical parent directory without replacing it.

Pi **1.4.0**, pi-subagents **0.84.0**, Node **v24.21.0**, npm **11.19.0**, daemon Vitest **4.1.6**, Playwright **1.58.2**. Exact executable/package paths are in [environment.json](environment.json).

| Check                           | Result                                                                 | Evidence                                                                                                                            |
| ------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Isolated real Pi daemon journey | PASS: 1 test, 18.06 seconds                                            | [Raw runner output](daemon-journey.txt), [raw journey observations](daemon-observations.jsonl)                                      |
| Real browser journey            | PASS after gate repair: 2 tests, 1.3 minutes                           | [Passing runner output](browser-gate-repair-1/browser-journey.txt), [screenshots and observations](browser-gate-repair-1/README.md) |
| Current codemode launch         | UNSUPPORTED: model-only `subagent` tool in Pi 1.4 / pi-subagents 0.84  | [Current reconciliation contract](../../../pi-workflow-status-plan.md)                                                              |
| Repository typecheck            | PASS, exit 0; no declaration rebuild needed                            | [Raw output](typecheck.txt)                                                                                                         |
| Repository lint                 | PASS, exit 0; 0 warnings, 0 errors                                     | [Raw output](lint.txt)                                                                                                              |
| Format and format check         | PASS, exit 0; final working-tree status contains only expected changes | `format.txt`, `format.exit`, `format-check.txt`, `format-check.exit`                                                                |

The daemon journey exercised direct launch; a running workflow and child shell while the parent was idle; a running workspace with an isolated idle observer; complete settlement of all eight rows and five child transcripts; isolated daemon restart and identical replay; script failure; explicit stop; and owner-death cancellation preserving completed children. Its raw JSONL records each stage, empty process leftovers, and removal of `/tmp/paseo-pi-workflow-e2e-gCiNwg`. The 88 workflow and 24 adapter tests already reported green were not rerun.

The original browser attempt ran outside the documented Nix development shell. Both tests reproduced this Chromium dynamic-library load failure:

```text
/home/sinkerine/.cache/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-linux64/chrome-headless-shell: error while loading shared libraries: libglib-2.0.so.0: cannot open shared object file: No such file or directory
```

Chromium exited **127**; the Playwright/npm command exited **1**. Its original raw output and two launch-failure traces remain unchanged. The authorized recovery used the existing Nix development shell documented in `docs/development.md`, which supplies browser libraries and fonts. The exact same npm script, spec and launcher ran once through `nix develop`; no install or launcher override was needed.

The recovery produced **1 passed, 1 failed (1.1 minutes)**. The wide/compact workflow pane test passed in **23.9 seconds** and saved four screenshots. The tree disclosure/settlement/reload test failed in **16.8 seconds**, at `expectRunningTree` (`pi-workflow-subagent-tree.real.spec.ts:74`, called at line 189): the five expected running-tree rows had settled to a single `Workflow2 of 2 groups done` row before the assertion. This is consistent with shared harness gate state: the runtime is worker-scoped, the first test reopens the gate in its `finally` block (line 171), and the second test does not remove it before launch (lines 184–189). This source-backed cause is recorded without changing the harness or retrying again. The subsequent authorized repair reset the shared gate before each test; both tests then passed together on one worker. See [repair 1 evidence](browser-gate-repair-1/README.md).

Recovery artifacts are in [browser-nix-retry](browser-nix-retry/README.md): raw output, four passing pane/run screenshots, failure screenshot/video/trace, error context, console output and runtime/cleanup records. The same Pi 1.4.0 / extension 0.84.0 assertions passed; the Nix shell used Node 22 (exact version in `browser-nix-retry/nix-runtime.json`).

Metro used port **42935**; browser worker daemons used **46665** and **45169**. The harness logged both daemon stops and Metro stop. [cleanup.json](cleanup.json) confirms all three known temporary roots were removed, no matching processes remained, and none of these ports remained listening. The browser runtime's temporary Pi root cleanup also passed its fixture assertion. The production listener on **6767** retained PID **813116** before and after; the `production-listener-*.txt` files record that read-only observation. No production restart occurred.

Changed files are this new evidence directory and a five-line gate-reset addition in `packages/app/e2e/browser/pi-workflow-subagent-tree.real.spec.ts`. The pre-existing `CLAUDE.md` modification and untracked `docs/features/pi-workflow-auto-resume-design.md` were left untouched. No commits, staging, or production feature edits were made. The test repair preserves every existing assertion and cleanup release. Review of the feature fix was already reported complete with no findings; the Nix retry resolved the environment blocker and exposed shared gate state in the existing harness. After resetting that gate before each test, both the wide/compact panes and the full tree lifecycle journey passed together. Ten current screenshots, rail measurements, and journey observations are retained under `browser-gate-repair-1/browser-results/`. Native and Electron platforms were outside this targeted run.

Exact launch and final verification commands are in [commands.md](commands.md). Raw runner output and observations are retained without rewriting. Final repair verification and cleanup are recorded under `browser-gate-repair-1/`; its worker daemon port 33417 and Metro port 38963 were cleaned, and production retained PID 813116.
