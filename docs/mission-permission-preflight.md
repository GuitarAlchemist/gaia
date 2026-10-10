# Mission permission preflight

Refs [runner #103](https://github.com/GuitarAlchemist/gaia/issues/103).
Source baseline: `3b2adc200ec19a3c4f3680773adb7152f3350a95`.
Intent: prevent a streaming mission starting when its declared file actions or
the mandatory completion Write cannot run under the effective dontAsk profile.
No new orchestrator, structural grant, permission mutation, retry or fallback.

## Decision receipt (ENG-02)

Parsing configured allow rules inside the runner would need to reproduce provider
precedence, denies, settings, hooks and path semantics. It would confuse intended
configuration with effective permission. Rejected.

Selected: keep a small pure comparison inside the existing provider adapter,
with an injected observation port at the launch boundary. The trusted host declares
the mission requirements; the observer measures effective decisions for this exact
invocation. Provider-specific collection and rule evaluation stay outside the runner.
An unavailable observer refuses instead of guessing. This is a freely reversible
patch, but rollback is an explicit operator disposition, never automatic permission
fallback. No new dependency, language, top-level module or recurring workflow.

Decision bytes (UTF-8, without a trailing newline):

```json
{"baseline":"3b2adc200ec19a3c4f3680773adb7152f3350a95","issue":103,"alternatives":["parse configured allow rules inside runner","compare exact effective decisions through an observation port"],"selected":2,"boundary":"existing streaming adapter immediately before launch","scope":"declared exact file capabilities plus protocol result Write","unknown":"WAITING_PERMISSION; zero launches","rollback":"revert patch only after explicit operator disposition; never automatic fallback"}
```

Decision revision: `sha256:9f35140b05ba41fab40b09ed8a08e2440a7296005aef3fded9db4cd525599dc4`.

## Adapter contract

`createStreamingClaudeAdapters({ observePermissions })` retains the existing
worker, repair and reviewer ports and successful result format. Every streaming
role now requires `context.requiredCapabilities`, an array of at most 255 exact
`{ tool, path }` actions. An explicit empty array declares a mission needing only
the protocol Write. The trusted host must supply a complete manifest; this slice
does not infer actions from natural-language task text or authenticate a caller's
claim of completeness. Allowed tools are Read, Write, Edit, Glob and Grep, with
exact target paths, not rule patterns. Invalid/missing declarations refuse with
`MissionRequirementsUnknown`. SPAWN/STOP/OBSERVE are separate lane authority and
cannot satisfy this contract.

The adapter resolves the cwd through `realpathSync`, resolves declarations and
observed targets with `resolve(cwd, path)`, deduplicates exact tool/path pairs,
then adds `Write(resultPath)` even for an Edit-only mission or a reviewer.
Resolution is lexical below the verified cwd: symlink-target authorization,
glob semantics, hooks and provider settings must be resolved by the effective
observer. This is a trusted host boundary, not an OS sandbox. Differently spelled
Windows targets may conservatively refuse; they never gain permission from a
case-insensitive or guessed prefix match.

The observer receives the frozen launch request, including cwd, binding, arguments,
environment, resultPath and the normalized requiredCapabilities. It must return:

```js
{
  schema: 'gaia-effective-permissions/1',
  source: 'effective-permissions',
  complete: true,
  binding: request.binding,
  cwd: request.cwd,
  permissionMode: 'dontAsk',
  observedAt: /* integer Unix milliseconds */,
  expiresAt: /* integer Unix milliseconds, at most 30 seconds after observedAt */,
  decisions: [
    { tool: 'Edit', path: /* exact target */, decision: 'allow' },
    { tool: 'Write', path: request.resultPath, decision: 'allow' }
  ]
}
```

The observer is trusted composition, not an observation accepted from task text or
`context`. It must account for all effective deny/allow/settings/hook rules for
the exact invocation, and answer unknown when it cannot. The source tag is a
contract discriminator, not cryptographic authentication. `--allowedTools` alone
and the list of enabled tools do not meet this contract.

Observation is bounded to the smaller of timeoutMs and 5 seconds, sharing the
streaming attempt deadline with provider execution. An exception or
missing response becomes unknown; a late response cannot resume this attempt or
launch a provider. The port owns cancellation of its external collection resources.

Immediately after observation, the pure comparator checks the exact binding, cwd,
mode, completeness and freshness at wall-clock now. Decisions are bounded to 512.
No await occurs between this comparison and launch. For each required action all
matching decisions must be allow; an absent, denied, unknown or conflicting action
is missing. Unknown, future, expired, incomplete or wrongly bound observation
makes every required action unproven. The refusal is a FactoryAgentError with
`code` and `status` equal to `WAITING_PERMISSION`, a named `reason`, and
`missingCapabilities` containing exact normalized tool/path pairs.

## Scope and operational limit

Only the streaming adapter is gated in this first slice; visible and headless
profiles retain their public behavior. The default observation port returns unknown.
The autonomous CLI has neither a live effective-permission collector nor a complete
mission manifest today, so its streaming adapter invocation now refuses. The existing host catches that
refusal and publishes RECONCILIATION_REQUIRED, retaining the original slot/budget;
the CLI does not expose a durable WAITING_PERMISSION state. This is an honest
blocker, not evidence of a resumed lane. Host authority/budget consumption still
precedes the factory invocation; this patch does not introduce a durable waiting
state, release its job slot, or retry the job. A follow-up must bind real observation
and complete host manifests before production streaming execution can resume.

Existing terminal-observability, bounds, subscription environment, result binding,
stop-before-acceptance, and output limits remain. Result directories are retained
for diagnostics as before. Nothing changes permission settings or structural lane
generation capabilities.

## Verification and evidence limits

Regression tests drive `createStreamingClaudeAdapters.runWorker`:
the wrong Edit target plus missing Write yields both missing capabilities and zero
launches; corrected Edit alone still refuses; observed Edit and Write launch once.
Unknown/stale/future/wrong binding/wrong cwd/incomplete/configuration-only observations,
denied/conflicting actions and structural-only declarations refuse without launch.

The test-only commit is the mechanism-revert witness: it exercises the old launch
mechanism with the same refusal oracle. GitHub CI links and exact revisions belong
in the draft PR. Fixtures prove adapter behavior, not installed Claude permissions,
Claude resumption, cancellation of a real mission, or runner recovery. Local commands
are unavailable and prohibited in this task. The existing CI runs node --test and
the architecture gate; standalone focused commands, npm run verify and the full
detached-clone reviewer protocol are unexecuted unless separately evidenced.

## Integration investigation — 2026-10-10

Outcome: **BLOCKED — effective action permissions are not observable through the
verified current composition.** This is insufficient runtime evidence, not a
claim that every Claude version lacks an inspection API. The user requested the
next #103 slice: connect a reliable effective observer and complete business
manifest to the CLI, then execute one admissible real mission once and obtain
its real receipt. That acceptance is **not met**.

Producer: Codex, GitHub-connector source inspection only. Gaia code revision:
`0fb646859159ec7e83eea38a3832e622a6057f50`; main still `3b2adc200ec19a3c4f3680773adb7152f3350a95`.
Environment: GitHub and existing GitHub CI only; Windows shell/local execution
prohibited. No credentials, user/managed settings, registry, or local files read.
No provider process or real mission was started during this investigation.

### Observed composition versus the required evidence

- [CLI composition at line 169](https://github.com/GuitarAlchemist/gaia/blob/0fb646859159ec7e83eea38a3832e622a6057f50/scripts/github-portfolio-autonomous.mjs#L169)
  passes only isObservable to the streaming adapter. It has no observer or
  manifest option. Worker/reviewer/repair wrappers pass their existing contexts.
- [Factory worker context at line 1031](https://github.com/GuitarAlchemist/gaia/blob/0fb646859159ec7e83eea38a3832e622a6057f50/src/factory-agent.mjs#L1031)
  contains cwd, task and baseHead, without requiredCapabilities; review and repair
  contexts also omit it. Pi's separate allowedPaths contract is not a complete
  Claude Read/Edit/Write/Glob/Grep manifest and is not passed through this CLI.
- The checked tree contains no .claude/settings.json or settings.local.json.
  That does not prove absence of host, managed or remote settings. package.json
  includes no Claude Agent SDK dependency; the Claude executable/version is not
  pinned or observed. Gaia structural policy JSON does not grant file-tool authority.
- The available stream renderer observes tool names/events after provider launch.
  It cannot establish exact permitted paths before the mission.
- Thus every new tick/watch execution reaching this streaming factory is blocked
  on this draft. The first refusal is caught by the host as RECONCILIATION_REQUIRED,
  retaining slot/budget and stopping watch. Administrative enable/status/revoke
  are not streaming invocations. **Do not merge this as restored autonomy.**

### Official contracts inspected

These are pinned official upstream sources, not the installed runtime:

- TypeScript SDK commit `85d8f8e0772199ec7965a0c2e874ac88343f2a01`,
  [CHANGELOG.md](https://github.com/anthropics/claude-agent-sdk-typescript/blob/85d8f8e0772199ec7965a0c2e874ac88343f2a01/CHANGELOG.md):
  version 0.2.136 introduced alpha resolveSettings for merged settings, including
  managed OS sources. getSettings also exists. Neither entry establishes a
  side-effect-free allow/deny verdict for an exact tool input including runtime
  hooks and safety checks. The inspected public tree has no implementation or API declarations of the SDK's
  permission/settings APIs; its linked external reference
  was not fetched under this task's GitHub-only boundary.
- Python SDK commit `b6e9d12fe1cc98dde988ab7b7713c1feeee50c6c`,
  [types.py:2508](https://github.com/anthropics/claude-agent-sdk-python/blob/b6e9d12fe1cc98dde988ab7b7713c1feeee50c6c/src/claude_agent_sdk/types.py#L2508):
  can_use_tool replaces permission prompts; it does not observe already allowed
  calls and allow rules can shadow it. PreToolUse observes/gates actual calls
  during execution; returning allow can also bypass the permission callback.
  Neither is a verified pre-mission observer. get_server_info and SystemInitData
  provide session/tool/mode metadata, not exact action permission verdicts.
  The inspected control protocol and query methods expose no exact-action
  preflight evaluator. This is coverage of those contracts, not universal absence.
- Claude Code commit `2301018b1f61073c501a8e7a4813ef48c239163b`,
  [CHANGELOG.md](https://github.com/anthropics/claude-code/blob/2301018b1f61073c501a8e7a4813ef48c239163b/CHANGELOG.md):
  records runtime hooks, safety checks and corrected path-scoped denial behavior.
  Reading settings or --allowedTools cannot reproduce these decisions reliably.
  Its settings-example README explicitly labels the snippets community-maintained;
  they are not evidence of the host's actual effective profile.

Attempts: read the above files and complete relevant source/type sections via
GitHub, inspect repository trees and CLI/factory composition, and search the
official SDK repositories for getSettings and permission preflight. The latter
returned no matches; search absence is not proof of API absence. No local command,
SDK query, runtime settings inspection, permission probe or mission was executed.
No new RED/GREEN claim is made for runtime integration. Existing PR246 regression
and CI receipts remain historical evidence of the preflight mechanism only.

### Minimal next solution, proposed and not implemented

1. At the existing admission boundary, check observer/manifest availability before
   store.start. Return a named unavailable/unknown refusal without consuming the
   execution slot or run budget. Do not refund an already-started job automatically.
   This prevents collateral pump blockage; it does not authorize a mission.
2. Carry an explicit host-owned complete tool/target manifest through the existing
   execution/factory contexts for each role, bound to the immutable job intent and
   source revision. Never derive completeness or authority from prose, labels,
   enabled-tool names or structural capabilities.
3. Supply a documented, verified runtime observation contract that evaluates those
   exact actions against the same cwd/invocation and all effective policy sources,
   hooks and safety checks before releasing mission work. resolveSettings may be
   an input, but must not be relabeled as this proof. Until that contract and the
   installed runtime are actually observed, leave the production integration blocked.
4. Once those prerequisites are proved, run one authorized real mission once and
   bind its stopped-provider/result receipt to the invocation. Fixtures and a
   settings-only probe cannot close that acceptance criterion.

No production wiring, permission mutation, dependency installation or fallback
was introduced by this investigation. The draft and its original failure oracles
are retained. This report is supporting evidence, not runtime authority or an
activation receipt.
