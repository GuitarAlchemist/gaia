# SDK scope and terminal contract (#103)

This draft replaces PR246's unimplemented exact-permission preflight proposal. It does not merge or activate PR246. Source base: 856adad162fd921eb86fc06b5fb7e490e2b9c5fb. Runtime candidate: SDK0.3.296/CLI2.1.296, confirmed in the [pinned changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/85d8f8e0772199ec7965a0c2e874ac88343f2a01/CHANGELOG.md). Installed runtime is unobserved.

## Decision

Keep the existing worker/reviewer/repair adapter and host admission. Design A: simulate all effective permissions before launch (rejected: inspected contracts provide no such proof). Design B: check transport/manifest readiness before consuming a run, then deny out-of-scope requests in programmatic PreToolUse, leaving native permissions to decide in-scope requests (selected). Reversible by explicit revert; no fallback or automatic permission change.

Readiness is availability and shape validation, not evidence that every future tool call is permitted. Lane structural authority cannot satisfy the business manifest. Existing callers without a readiness port keep their existing contract; the autonomous CLI explicitly requires the SDK port and remains unavailable until trusted transport and manifests are supplied. No SDK dependency, installation or runtime collector is added.

## Runtime boundary

A trusted composition supplies SDK query and observed runtime identity with verified protection compatibility. These declarations are not accepted from task text or an observation file and do not prove an installed runtime here. Complete exact Read/Edit/Write capabilities are supplied by the host per role and resolved against one physical cwd. Glob/Grep patterns, Bash, subagents and other tools are unsupported and denied. Result Write is added separately.

PreToolUse returns an empty object for a supported exact target and deny otherwise; never allow, updatedInput or updatedPermissions. Symlink paths and ambiguous targets refuse. SDK settingSources is not overridden. The existing --restricted profile remains: the [CLI contract](https://code.claude.com/docs/en/cli-reference) says this loads managed settings and explicit --settings, rather than user/project settings. We do not claim all filesystem hooks load under restricted mode. Effective managed policy and native checks still decide; dontAsk, restricted execution, strict empty MCP configuration and disabled slash commands remain. No blanket allowedTools is supplied. See [permissions](https://code.claude.com/docs/en/agent-sdk/permissions), [hooks](https://code.claude.com/docs/en/agent-sdk/hooks), and [settings behavior](https://code.claude.com/docs/en/agent-sdk/claude-code-features). Native rules/hooks still decide requests passed by the scope hook. canUseTool is not used; PermissionDenied is not a dontAsk observer.

## Completion and reconciliation

A completion file alone is insufficient. Result Write must be admitted with no outstanding tool calls; its admission immediately fences every later tool call, before any asynchronous PostToolUse. Acceptance separately requires successful correlated result Write observed through PostToolUse, one successful SDK terminal result with no permission_denials, stream termination and closed query, followed by stable result-file validation. Faults delivered by hooks during the awaited query closure are included in the outcome. A late native denial, scope refusal, missing event, timeout, or terminal failure refuses; no retry or profile widening. Once store.start has consumed a run, failures retain the operation for reconciliation with no automatic refund.

The runtime/manifest readiness port is bounded before store.start. A late response cannot start work. Readiness failure does not consume a slot. It grants no authority and does not replace the existing fresh admission or store policy check.

## Evidence limits

Tests inject SDK query/events; they are adapter tests, not Claude acceptance. Existing CI runs node --test and architecture checks. Real provider execution, installed-version/protection verification, complete CLI manifests, initial Blue ownership and a durable admission/first-action/result receipt remain unexecuted. Existing final receipt and reconciliation stay in place. No runtime installation, settings change, merge, second orchestrator or automatic replay is authorized by this document.

Live activation also remains blocked on managed/parallel hook compatibility. An empty scope-hook result does not prove another effective hook cannot return updatedInput that widens the actual target. The trusted runtime verification must establish how the final effective tool input remains inside the exact manifest; injected adapter tests do not establish hook composition or native permission behavior.

### Test-first evidence

RED commit a1553a77bf65a023be5a12db6f3fdfa54b26080d: [existing CI38082514171](https://github.com/GuitarAlchemist/gaia/actions/runs/38082514171). Windows 2531 executed, 2525 passed, 4 failed, 2 skipped, 0 cancelled. Linux 2483 passed, same four failures, 44 skipped; architecture passes. The old mechanism ignores readiness and accepts result-file bytes before late-denial observation. After RED, the positive fixture supplies the normal PostToolUse event for its Edit, and the refusal oracle is unchanged. Additional timeout-late-response and actual SQLite budget assertions strengthen the same readiness test.

Full corrected CI and independent source review bind to the published candidate, with real-runtime acceptance still blocked. Restricted-mode SDK options are constructed but not exercised against an installed SDK in this task; no activation is claimed.

### Review-counterexample regressions

Test-only commit d0896f491caebf19207d60c75c4890caafe150c0 adds regressions for overlapping Edit/result Write admission and both completion orders, an awaited close-time PostToolUseFailure, and Windows target casing. The Windows cases run in a bounded subprocess because the original synchronous ancestor loop prevents an in-process timeout from firing. Same-spelling paths are positive controls; drive and directory casing are varied for existing Edit and missing-leaf Write targets. RED CI: [38090140428](https://github.com/GuitarAlchemist/gaia/actions/runs/38090140428). Windows reproduced all four drive/directory casing hangs with same-spelling controls passing, all four overlap cases, and the close-time failure. Linux reproduced the overlap and close-time failures; the native Windows cases are skipped there. Architecture passed.

The repair bounds the ancestor walk by relative component count, inspects the actual target spelling, and compares physical boundary directory identity. This also refuses a differently cased sibling or symlink in a case-sensitive Windows directory. It does not lowercase or broaden manifest capabilities. Admission and successful completion remain separate facts; refusal is sticky, and final outcome construction follows query closure. These changes stay inside the existing provider adapter and preserve native dontAsk decisions.

The additional injected Windows-filesystem test distinguishes a same-directory casing alias from a different case-sensitive sibling, symlink boundary, missing parent, and unusable filesystem identity. It models observations without enabling case sensitivity or altering security settings; native NTFS case-sensitive-directory acceptance remains unexecuted.
