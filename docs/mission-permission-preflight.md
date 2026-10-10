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
mission manifest today, so its streaming invocation now refuses. This is an honest
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
