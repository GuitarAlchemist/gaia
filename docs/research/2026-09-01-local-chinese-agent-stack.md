# Local Chinese agent stack for Gaia: security-first hardware fit

Date: 2026-09-01

## Question

Which China-origin open-weight coding models and agent harnesses are plausible on the current Windows host (RTX 5080, 16 GB VRAM, 64 GB RAM) without creating a new security or cost risk for Gaia?

## Boundary

This note authorizes no download, installation, model execution, repository write, credential access, or provider spend. It distinguishes the model from the agent harness:

- the **model server** performs inference and owns no tools or repository authority;
- the **agent harness** owns context assembly and tool requests;
- the **Gaia adapter** validates a closed mandate and is the only component that may translate an accepted request into a typed action;
- GitHub remains durable authority and DuckDB remains a rebuildable projection.

IX issue [#293](https://github.com/GuitarAlchemist/ix/issues/293) owns offline Qwen + DuckDB Agentic SQL evaluation. Gaia issue [#91](https://github.com/GuitarAlchemist/gaia/issues/91) owns provider-neutral runner and adapter behavior. Neither repository becomes a runtime dependency of the other.

## Primary-source findings

### Qwen3-Coder-30B-A3B-Instruct is the first model to measure

The official model card identifies 30.5B total parameters, 3.3B activated parameters, 256K native context, Apache-2.0 licensing, `safetensors`, and agentic coding/tool-call support. The unquantized repository is about 61 GB, so a quantized build is required and hardware fit must be measured rather than inferred from active-parameter count alone.

Sources:

- <https://huggingface.co/Qwen/Qwen3-Coder-30B-A3B-Instruct>
- <https://github.com/QwenLM/Qwen3-Coder>

Provisional fit: a 4-bit quantization is likely to require hybrid VRAM/RAM placement on this host. It is a candidate for asynchronous review or bounded coding only after measured peak RAM/VRAM, tokens per second, context degradation, and exact-answer evaluation.

### Qwen3-Coder-Next is not the R0 local lane

The official card describes an 80B-total, 3B-active hybrid MoE model with 256K context and Apache-2.0 licensing. Low active parameters reduce compute per token but do not make the 80B weight set fit in 16 GB VRAM. It may fit in system RAM when heavily quantized, but that does not prove useful interactive latency.

Sources:

- <https://huggingface.co/Qwen/Qwen3-Coder-Next>
- <https://github.com/QwenLM/Qwen3-Coder>

R0 ruling: reject it as the default lane until the smaller candidate passes and a measured experiment proves that Next adds enough accepted evidence per joule and wall-clock minute.

### DeepSeek-Coder-V2-Lite is a fallback, not the default

The official card identifies a 16B-total, 2.4B-active model with 128K context under the DeepSeek license. Its smaller weight set is attractive for this host, but the official Transformers example uses `trust_remote_code=True`; that is an avoidable supply-chain execution surface.

Sources:

- <https://huggingface.co/deepseek-ai/DeepSeek-Coder-V2-Lite-Instruct>
- <https://github.com/deepseek-ai/DeepSeek-Coder-V2>

R0 ruling: consider only a pinned, audited runtime path that does not execute mutable remote code. License and quantization artifacts must be reviewed independently.

### Current GLM agentic models exceed this host's prudent R0 envelope

The official GLM-4.5/4.6/4.7 repository describes strong agentic and coding behavior, but its full-featured inference table uses H100-class configurations; even GLM-4.7-Flash is specified on one H100 and the larger variants require multiple H100s and very large host memory.

Source:

- <https://github.com/zai-org/GLM-4.5>

R0 ruling: do not spend time adapting GLM on this 16 GB workstation until a first-party smaller coding checkpoint with a verified local configuration exists.

### Qwen Code is the most relevant harness, but not a Windows sandbox

Qwen Code is an open-source terminal agent with headless, SDK, subagent, IDE, and experimental HTTP/SSE daemon modes. It supports custom OpenAI-compatible local endpoints and explicit run budgets. Its plan approval mode performs analysis without file edits or commands.

Sources:

- <https://github.com/QwenLM/qwen-code>
- <https://github.com/QwenLM/qwen-code/blob/main/docs/users/configuration/model-providers.md>
- <https://github.com/QwenLM/qwen-code/blob/main/docs/users/features/headless.md>
- <https://github.com/QwenLM/qwen-code/blob/main/docs/users/features/approval-mode.md>

However, the official sandbox documentation states that Linux/Windows sandbox mode requires Docker or Podman. Gaia's current operator constraint rejects Docker for this path, and Qwen Code warns that permissive unattended modes without a sandbox execute tools with the host process's privileges.

Source:

- <https://github.com/QwenLM/qwen-code/blob/main/docs/users/features/sandbox.md>

R0 ruling: Qwen Code may be evaluated only in `plan` mode on the host. Any future tool-bearing run requires a disposable Windows Sandbox/VM or a dedicated low-privilege host account with an independent security review. `yolo`, `auto`, shell, write, MCP, plugins, telemetry export, and remote bind remain disabled.

## Security admission sequence

Each phase is a separate gate. Failure stops the experiment without affecting Gaia delivery.

1. **Static provenance**
   - official organization and immutable revision;
   - license review;
   - `safetensors` or a locally produced GGUF from pinned official weights;
   - SHA-256 manifest, malware scan, dependency lock, and reproducible download log;
   - no `trust_remote_code`, install script, unsigned binary, model plugin, or arbitrary post-install hook.
2. **Inference-only synthetic fixture**
   - loopback-only server with firewall-denied egress;
   - no filesystem mount beyond immutable model files;
   - no repository, credentials, browser, MCP, shell, or tool schema;
   - fixed prompt corpus containing no private source.
3. **Immutable repository snapshot review**
   - disposable copy at a fixed SHA, read-only ACL, no `.git` credentials;
   - output is an advisory artifact, never an approval or effect;
   - prompt-injection fixtures must not cause tool requests or data exfiltration.
4. **Typed Gaia adapter canary**
   - closed read-only tool vocabulary and JSON schema;
   - one mandate, TTL, token/context/tool budget, owner, supervisor, and kill switch;
   - deny-by-default egress and path allowlist;
   - deterministic replay plus an independent Standards and Spec review before any write capability.

No phase may silently inherit authority from the next phase.

## R0 evaluation matrix

| Candidate | Initial role | Why | Admission blocker |
| --- | --- | --- | --- |
| Qwen3-Coder-30B-A3B-Instruct | asynchronous read-only review | current open Qwen coding model with manageable total size after quantization | measured 16 GB fit, safe quantization provenance, exact-answer quality |
| DeepSeek-Coder-V2-Lite-Instruct | fallback read-only review | smaller total weights and sparse activation | custom license review and no-remote-code runtime proof |
| Qwen3-Coder-Next | deferred research | strong agentic training, but 80B stored weights | useful latency and memory not proven on this host |
| GLM-4.7 family | rejected for R0 | official deployment envelope is datacenter-class | first-party small checkpoint and measured workstation support absent |
| Qwen Code | plan-only harness | provider-neutral local endpoint, headless budgets, explicit plan mode | Windows sandbox requires Docker/Podman; tool-bearing use is refused |

## Measurements before adoption

- immutable model and quantization digest;
- cold-load time, peak VRAM/RAM, median/p95 latency, tokens per second, and energy estimate;
- exact-answer and patch-applicability rates on frozen holdouts;
- unsafe-tool-request and prompt-injection refusal recall;
- accepted findings per wall-clock hour and per kWh;
- comparison with a deterministic baseline and subscription-backed Claude/Gemini/Auggie lanes;
- failure containment and byte-identical replay from the same input artifact.

## Decision

Do not install or run a local Chinese model yet. Groom one inference-only, synthetic-fixture experiment around Qwen3-Coder-30B-A3B-Instruct under IX #293, and expose any later result to Gaia through the existing optional advisory-package boundary. For Gaia #91, treat `qwen-local` as an unavailable capability until all four security gates pass. This preserves the core pump while creating a cost-effective path that cannot access source, secrets, or effects prematurely.
