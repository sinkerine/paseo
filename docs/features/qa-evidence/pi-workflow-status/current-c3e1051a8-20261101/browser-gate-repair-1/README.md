# Gate isolation repair 1: PASS

Both tests in the existing browser spec passed sequentially on **one worker** after the gate reset repair: **2 passed (1.3 minutes), exit 0**. The pane test took **22.9 seconds** and the tree lifecycle test took **25.8 seconds**. No daemon or unit suites were rerun. Earlier failures remain unchanged in the parent directory and `browser-nix-retry/`.

The change adds a `test.beforeEach` in `packages/app/e2e/browser/pi-workflow-subagent-tree.real.spec.ts` that removes the worker-shared gate with `{ force: true }`. The first test's cleanup intentionally opens that gate to unblock any remaining child. Resetting it before each test preserves this cleanup while preventing the next test from launching with an already-open gate. No assertions, polling, workflows, production feature code, or helper cleanup were changed. [repair.diff](repair.diff) contains the exact five-line addition.

Exact command from the repository root:

```bash
nix develop -c env \
  PASEO_PI_BINARY=/nix/store/v86wfk7n5acr75lbhd5aa2qsfbf615rb-pi-coding-agent-1.4.0/bin/pi \
  PASEO_PI_SUBAGENTS_PACKAGE=/nix/store/spwn6yyrml8by6wpw6l4a0f0jhybs9m9-pi-subagents-0.84.0/lib/node_modules/pi-subagents \
  npm run test:e2e:real --workspace=@getpaseo/app -- \
  e2e/browser/pi-workflow-subagent-tree.real.spec.ts --workers=1 \
  --output=/home/sinkerine/dev/paseo/docs/features/qa-evidence/pi-workflow-status/current-c3e1051a8-20261101/browser-gate-repair-1/browser-results
```

[Raw output](browser-journey.txt) and [exit status](browser-journey.exit) record both tests on worker 0 with the same isolated daemon. Pi **1.4.0** and pi-subagents **0.84.0** passed the runtime fixture's version assertions. This uses the same documented Nix shell and unchanged Playwright **1.58.2** launcher as the prior recovery.

`browser-results/pi-workflow-subagent-tree.-75d17-on-wide-and-compact-layouts-real-provider/` contains four screenshots: `workflow-pane-wide.png`, `workflow-run-wide.png`, `workflow-pane-compact.png`, and `workflow-run-compact.png`.

`browser-results/pi-workflow-subagent-tree.-7e442--tools-settles-and-rebuilds-real-provider/` contains six screenshots: `pi-workflow-wide-running.png`, `pi-workflow-review-bash.png`, `pi-workflow-wide-completed.png`, `pi-workflow-wide-complete-expanded.png`, `pi-workflow-compact-running.png`, and `pi-workflow-compact-reloaded.png`. It also contains `wide-rails.json`, `compact-rails.json`, and `journey.json`, proving indentation measurements and before/after row text. Playwright attachment copies are preserved. Successful traces/videos are not retained by the existing harness policy.

The passing tree test verifies independent disclosure, child shell streaming, complete settlement, completed-tree ordering, browser reload, archive-finished removal, compact viewport placement, and compact reload while running. This run exercises the previous cross-test failure with both tests in their original order.

The raw output retains existing module-cycle warnings and archived-agent refresh errors during cleanup; both tests and cleanup assertions pass. No broader repairs were attempted.

Cleanup: worker daemon **33417** and Metro **38963** stopped. [cleanup.json](cleanup.json) records no matching processes, no listeners on either allocated port, and the removed daemon/Pi runtime roots. Remaining caches in the dedicated `/tmp/nix-shell.Aa4CUI` root were removed only after checking no processes referenced it. Production port **6767** retained PID **813116** in before/after listener snapshots. No staging or commits occurred.

Final verification uses npm scripts for the changed spec and final evidence Markdown/JSON files, plus repository typecheck and lint. Raw output and exit files are `format.txt`, `format-check.txt`, `typecheck.txt`, `lint.txt` and their matching `.exit` files. `verification-commands.json` records the exact argument lists. `git diff --check` and `git diff --cached --exit-code` also pass. Current codemode launch remains unsupported because `subagent` is model-only.
