# Commands and results

The journeys ran sequentially. Each command's stdout/stderr was redirected to the corresponding `.txt` file; its shell exit status is in the matching `.exit` file.

Daemon journey, from `packages/server` (exit **0**):

```bash
PASEO_PI_BINARY=/nix/store/v86wfk7n5acr75lbhd5aa2qsfbf615rb-pi-coding-agent-1.4.0/bin/pi \
PASEO_PI_SUBAGENTS_PACKAGE=/nix/store/spwn6yyrml8by6wpw6l4a0f0jhybs9m9-pi-subagents-0.84.0/lib/node_modules/pi-subagents \
npx vitest run src/server/daemon-e2e/pi-workflow-subagents.local.e2e.test.ts --bail=1
```

The generated `.dev/paseo-pi-workflow-e2e-gCiNwg-journey.jsonl` was copied unchanged to `daemon-observations.jsonl`.

Browser journey, from repository root (exit **1**, both tests blocked before page creation):

```bash
PASEO_PI_BINARY=/nix/store/v86wfk7n5acr75lbhd5aa2qsfbf615rb-pi-coding-agent-1.4.0/bin/pi \
PASEO_PI_SUBAGENTS_PACKAGE=/nix/store/spwn6yyrml8by6wpw6l4a0f0jhybs9m9-pi-subagents-0.84.0/lib/node_modules/pi-subagents \
npm run test:e2e:real --workspace=@getpaseo/app -- \
  e2e/browser/pi-workflow-subagent-tree.real.spec.ts --workers=1 \
  --output=/home/sinkerine/dev/paseo/docs/features/qa-evidence/pi-workflow-status/current-c3e1051a8-20261101/browser-results
```

The existing npm script sets `E2E_FORK_PASEO_HOME_FROM=../../.dev/paseo-home` and invokes Playwright's `real-provider` project. No launcher override was supplied. A later authorized retry used the same script/spec/launcher through the documented Nix development shell; its exact command and result (1 passed, 1 failed) are recorded in [browser-nix-retry/README.md](browser-nix-retry/README.md). Original output remains unchanged. An authorized five-line gate-reset repair then passed both tests on one worker; its exact command, diff, output and final checks are in [browser-gate-repair-1/README.md](browser-gate-repair-1/README.md).

Final repository checks, from repository root (both exit **0**):

```bash
npm run typecheck
npm run lint
```

Formatting uses the requested npm scripts with an explicit ignore file to confine writes/checking to the final evidence files, protecting unrelated dirty/untracked work. The ignore file contents are preserved in `format-scope.txt`.

```bash
npm run format -- --ignore-path=/tmp/pi-workflow-acceptance-format.ignore
npm run format:check -- --ignore-path=/tmp/pi-workflow-acceptance-format.ignore
git diff --check
git diff --cached --name-only
```

Read-only runtime and cleanup verification included `git rev-parse HEAD`, `git status --short`, `node --version`, `npm --version`, the exact configured Pi binary's `--version`, pi-subagents `package.json`, the actual Vitest runner banner, Playwright's installed `package.json`, `ss -ltnp 'sport = :6767'` before/after, `ss -ltnp` for the three allocated browser ports, `ps -eo pid=,args=` filtered to the recorded temporary roots, and filesystem existence checks for those roots. Initial instructions, current plan, testing docs, QA docs, both journey specs, the scripted provider fixture, and their daemon/Metro/runtime cleanup helpers were inspected before launch. No unit suites were rerun.
