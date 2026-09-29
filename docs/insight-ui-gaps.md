# Insight UI gate: remaining product gaps — 2026-09-06

The final complete Electron run passed **88/94**, exit **1**. All 94 steps remain enabled.
Typecheck (both configurations) and build each exited **0**, in that order before the final UI run.
Only the test harness and two dead CSS rules were changed; no product behaviour was repaired.

## Failing steps

| Step | Observed failure | Diagnosis |
| --- | --- | --- |
| 14k | No analytics snapshot recorded | The renderer no longer calls `analyticsRecord`. The rebuilt Insight loader only calls `analyticsList`. The snapshot assertion remains. Later assertions in this combined step are not verified by this run. |
| 14kb | No Modified row for `src/main.tsx` | Diagnostics show the backend returning that exact file as `modified`, with +2/−0, while Overview displays “Not read yet” and “Your work — Not checked yet”. `use-insight-data.ts` clears Overview on `changeToken`; its loading effect does not depend on that token or the cleared slices. Even the explicit refresh can be followed by a file-watcher reset. Compare/Restore assertions remain, but this failure prevents reaching them. |
| 14l2 | No health trend sparkline | The test seeds one historical snapshot and expects opening Insight to record today. Recording was dropped, leaving only one point. No synthetic current point was added to hide this. Decision/context assertions remain but are not reached. |
| 14l4 | No action-plan Go button | `insight-overview.tsx` has Fix with AI and Generate tests, but no per-item Go action. The header's contextual primary button is not a replacement for each item's navigation. The original assertion remains, explicitly marked as a product gap. |
| 14l4d | No Created confirmation | The test file is created on disk, but diagnostics show Overview reset to “Not read yet” and the empty plan. Besides the reload defect above, `genTestMsg` is nested inside the nonempty-plan branch, so an empty plan hides the confirmation. The visible confirmation assertion remains. |
| 17 | 12 renderer console errors | All twelve are trusted Worker `error` events rethrown by Monaco's unexpected-error handler. Their requested Worker URL resolves to a nonexistent filesystem-root path; details below. |

## Additional gap found in source inspection

Work-safety's subfolder guidance is computed in `shared/worksafety.ts` as `WorkSafety.lines`
(“This project lives inside a bigger project…”). The rebuilt verdict renders `ws.verdict`
but never those lines. Step 14kb still asserts the guidance, after its currently failing
changed-file assertion. This additional loss is confirmed in source, not reached in the UI run.

## What the twelve errors actually are

All twelve observed Worker failures request:

```text
file:///_next/static/chunks/turbopack-worker-2ru9m5gbh1na6.js#params=…
```

`/_next/static/chunks/turbopack-worker-2ru9m5gbh1na6.js` does not exist. The corresponding
Worker file does exist at `apps/desktop/out/renderer/_next/static/chunks/turbopack-worker-2ru9m5gbh1na6.js`.
The generated Worker URL is rooted at the filesystem root instead of the renderer output directory.
The creation stacks pass through `MonacoEnvironment.getWorker`; Monaco then rethrows the bare event
from its unexpected-error handler at `1cc2kst180m24.js:1:38732` in this build.

These are bare `Event` objects, not exceptions containing hidden English messages:
`type=error`, `isTrusted=true`, `target=Worker`, and no message, filename, line, column, or nested error.
The collector now serializes available exception properties and CDP throw-site stacks, plus the
Worker constructor URL, creation stack, and ErrorEvent fields. It retains every original console
error in the gate, prints all of them in the failure report, and does not prevent or cancel events.
The Worker instrumentation is installed again on document reload.

## Verified improvements and limits

Destination staging was checked before classifying the remaining failures as product gaps.
`runInsightCheck` selects Review and explicitly runs the named check. The migrated tests select
Overview again before action-plan, ship-readiness and Fix-Verify assertions; Code Map before
architecture, authorship and related-file content; and Memory before ledger, replay and saved-memory
content, including after reopening the project. These navigation changes were present in both
observed 88/94 runs. The remaining analytics, changed-file and generation-confirmation failures
occur in their owning destination, Overview, rather than in a destination that never requested them.

One loading-cost clarification from the current source: Overview has four result groups but makes
eight IPC calls—three individual calls plus five inside the work-safety group. Review remains
explicitly run rather than automatically loaded.

The formerly failing passport, security, architecture/owners/replay, dependency verdict, dependency
Fix-with-AI, ship-readiness, upload-safety, Run Doctor, Fix-Verify, and project-memory steps now pass.
Memory's failure was navigation: the test returned to Overview immediately before looking for AI
memory and again after reload. It now explicitly selects Memory and preserves the AI attribution
and durability assertions. The three existing navigation helpers were left unchanged.

The actual Electron screenshot `apps/desktop/.ui-test/shots/54-wave18-ship-readiness.png` was visually
inspected: Overview displays a red “Not safe to ship yet” verdict for the seeded secret, the supporting
answers, action plan, project facts, and changed-file list. This is automated on-screen verification,
not a manual user walkthrough. Failed compound steps can leave later assertions unexecuted, as noted above.

Local run evidence: `/tmp/atomic-typecheck-final.log`, `/tmp/atomic-build-final.log`, and
`/tmp/atomic-ui-final.log`. Both complete UI runs in this pass observed 88/94 (exit 1).
Pre-existing untracked `leak.js` and `w16blind.tsx` fixture contents were restored after the suite.
Unrelated working-tree changes, including the server work, were preserved.
