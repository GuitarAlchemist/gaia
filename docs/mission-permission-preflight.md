# SDK scope and terminal contract (#103)

This draft replaces PR246's unimplemented exact-permission preflight proposal. It does not merge or activate PR246. Source base: 856adad162fd921eb86fc06b5fb7e490e2b9c5fb. Runtime candidate: SDK0.3.296/CLI2.1.296, confirmed in the [pinned changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/85d8f8e0772199ec7965a0c2e874ac88343f2a01/CHANGELOG.md). Installed runtime is unobserved.

## Decision

Keep the existing worker/reviewer/repair adapter and host admission. Design A: simulate all effective permissions before launch (rejected: inspected contracts provide no such proof). Design B: check transport/manifest readiness before consuming a run, then deny out-of-scope requests in programmatic PreToolUse, leaving native permissions to decide in-scope requests (selected). Reversible by explicit revert; no fallback or automatic permission change.

Readiness is availability and shape validation, not evidence that every future tool call is permitted. Lane structural authority cannot satisfy the business manifest. Existing callers without a readiness port keep their existing contract; the autonomous CLI explicitly requires the SDK port and remains unavailable until trusted transport and manifests are supplied. No SDK dependency, installation or runtime collector is added.

## Runtime boundary

A trusted composition supplies SDK query and observed runtime identity with verified protection compatibility. These declarations are not accepted from task text or an observation file and do not prove an installed runtime here. Complete exact Read/Edit/Write capabilities are supplied by the host per role and resolved against one physical cwd. Glob/Grep patterns, Bash, subagents and other tools are unsupported and denied. Result Write is added separately.

PreToolUse returns an empty object for a supported exact target and deny otherwise; never allow, updatedInput or updatedPermissions. Symlink paths and ambiguous targets refuse. SDK settingSources is not overridden. The existing --restricted profile remains: the [CLI contract](https://code.claude.com/docs/en/cli-reference) says this loads managed settings and explicit --settings, rather than user/project settings. We do not claim all filesystem hooks load under restricted mode. Effective managed policy and native checks still decide; dontAsk, restricted execution, strict empty MCP configuration and disabled slash commands remain. No blanket allowedTools is supplied. See [permissions](https://code.claude.com/docs/en/agent-sdk/permissions), [hooks](https://code.claude.com/docs/en/agent-sdk/hooks), and [settings behavior](https://code.claude.com/docs/en/agent-sdk/claude-code-features). Native rules/hooks still decide requests passed by the scope hook. canUseTool is not used; PermissionDenied is not a dontAsk observer.

## Completion and reconciliation

A completion file alone is insufficient. Acceptance requires successful correlated result Write observed through PostToolUse, one successful SDK terminal result with no permission_denials, stream termination and closed query, followed by stable result-file validation. A late native denial, scope refusal, missing event, timeout, or terminal failure refuses; no retry or profile widening. Once store.start has consumed a run, failures retain the operation for reconciliation with no automatic refund.

The runtime/manifest readiness port is bounded before store.start. A late response cannot start work. Readiness failure does not consume a slot. It grants no authority and does not replace the existing fresh admission or store policy check.

## Evidence limits

Tests inject SDK query/events; they are adapter tests, not Claude acceptance. Existing CI runs node --test and architecture checks. Real provider execution, installed-version/protection verification, complete CLI manifests, initial Blue ownership and a durable admission/first-action/result receipt remain unexecuted. Existing final receipt and reconciliation stay in place. No runtime installation, settings change, merge, second orchestrator or automatic replay is authorized by this document.

### Test-first evidence

RED commit a1553a77bf65a023be5a12db6f3fdfa54b26080d: [existing CI38082514171](https://github.com/GuitarAlchemist/gaia/actions/runs/38082514171). Windows 2531 executed, 2525 passed, 4 failed, 2 skipped, 0 cancelled. Linux 2483 passed, same four failures, 44 skipped; architecture passes. The old mechanism ignores readiness and accepts result-file bytes before late-denial observation. After RED, the positive fixture supplies the normal PostToolUse event for its Edit, and the refusal oracle is unchanged. Additional timeout-late-response and actual SQLite budget assertions strengthen the same readiness test.

Full corrected CI and independent source review bind to the published candidate, with real-runtime acceptance still blocked. Restricted-mode SDK options are constructed but not exercised against an installed SDK in this task; no activation is claimed.
