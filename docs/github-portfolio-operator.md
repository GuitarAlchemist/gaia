# GitHub portfolio operator CLI

The portfolio factory in `src/github-portfolio.mjs` can already survey an organization,
schedule work, and execute exactly one authorized intent. What it could not do was be
*operated*: the only way to reach the authorized path was to hand-assemble a signed
Ed25519 grant, which meant the grant material lived wherever the assembler put it. This
module is the missing operator seam. It exists so a human can authorize one factory run,
once, with a key that only that human can unlock — and so no agent can walk the same path
by itself.

## Design it twice

This is an authority seam, so the interface was chosen against alternatives rather than
found by writing code. Three materially different interfaces were considered.

### (a) One command: `run --organization ORG` that generates a key and executes

A single command that mints a keypair on first use, remembers it, and goes straight from
"there is ready work" to "the factory ran". Shortest operator path, fewest arguments,
nothing to lose.

It is rejected because it destroys the property the whole authority module exists to
create. If the command that executes is also the command that mints the key, then
possession of the ability to run the command *is* possession of the authority. An agent
that can invoke the CLI can mint itself a key, sign its own grant, and execute — the
Ed25519 signature still verifies, the ledger still records exactly one use, and every
control in `github-portfolio-authority.mjs` still passes, while having certified nothing.
The signature would attest that the process signed the payload, which was never in doubt.
Splitting `init` from `run` is what makes the key a thing a human holds: `init` is the
only writer of key material, it demands a passphrase from an interactive secret prompt, and `run` cannot
produce a key it was not given. The separation also makes the passphrase meaningful — a
key minted inside the executing command has no moment at which a human must be present.

### (b) Low-level plumbing: `keygen`, `sign-grant`, `execute`

Three orthogonal commands: mint a key, sign an arbitrary grant payload to stdout or a
file, execute a portfolio advance with a grant file. Maximally composable, each command
trivially testable, and it matches the shape of the underlying modules one-to-one.

It is rejected because it is a shallow module: it publishes the internal decomposition as
the interface, and every unit of safety then has to be re-established by whoever composes
the three calls. A separately invocable `sign-grant` means a signed grant exists as a
durable artifact — on disk, in a shell history, in a scrollback — where the pinned intent
revision it names can drift from the one that is later executed, and where nothing forces
the operator who *approved* an intent to be the same actor that *executed* it. It also
gives an agent the exact primitive it must never have: "sign this payload", with the
payload supplied by the caller. The intent digest would become a parameter the caller
types rather than a value the tool measured, which is precisely the substitution the
confirmation step exists to prevent. Three composable commands are also three places to
forget the output reservation, so the "there is always a receipt" property becomes a
convention instead of a mechanism.

### (c, chosen) Two commands: `init` and `run`

`init` mints a dedicated Ed25519 keypair and does nothing else. `run` takes a pinned
portfolio revision and performs the *entire* authorized advance as one indivisible
operation: re-read GitHub, materialize the exact first `AWAITING_AUTHORITY` intent,
display it as untrusted data, demand a confirmation bound to the full intent revision,
unlock the private key with an interactively-read passphrase, mint a short-lived grant in
memory, consume it, execute, and leave a receipt.

Execution may include one bounded repair after an initial independent
`REQUEST_CHANGES`, followed by one fresh final review. That correction is not another
operator action: it remains inside the already-confirmed intent, repository, linked
worktree, grant claim, and idempotency identity. The operator is not prompted again,
no second grant is minted, and a second `REQUEST_CHANGES` ends the run rejected.

This is deeper than (a) and (b) at the same interface width, and the depth is exactly the
part that is dangerous to reimplement per call site:

- **The grant never becomes an artifact.** It is built, signed, consumed, and dropped
  inside one function. There is no window in which a valid grant exists that someone
  other than the operator who confirmed it could spend, and no file to redact.
- **The digest is measured, not typed.** The intent revision the operator confirms is the
  one `advance()` just computed from a fresh GitHub read. In (b) it would be an argument.
- **Authority is bound to a human at the only moment it matters.** The passphrase is read
  from a masked Windows dialog or a hidden terminal reader on other platforms, between
  the display of the intent and the signature. No caller stdin pipe, no argv, no
  environment, no file. An agent driving the CLI with piped stdin cannot get past it.
- **The receipt is a mechanism.** `run` reserves the caller-named output path exclusively
  before it consumes authority, and from that point every path on which it returns —
  refusal, expiry, wrong passphrase, provider failure, and a prompt the operator walked
  away from — leaves a structured, redacted receipt at that path. There is no arrangement
  of the two commands that skips it, and no way to leave the terminal prompts without
  producing one; the exact scope and its one residue are stated under **Receipt** below.
- **Nothing new is granted.** `run` composes the existing read, authority, and execution
  adapters unchanged. It adds no GitHub mutation, no bus verb, and no configuration.

The cost is that `run` is not composable: an operator cannot reuse the signing step for
something else. That is the intent. The one operation it does perform is the one the
authority module was built to gate.

## Commands

### `init`

```
node scripts/github-portfolio-operator.mjs init \
  --private-key ../state/gaia-operator.key \
  --public-key  ../state/gaia-operator.pub
```

Generates a dedicated Ed25519 keypair. The private key is written as encrypted PKCS#8 PEM
(`aes-256-cbc`); the public key is SPKI PEM. The passphrase is read twice from a masked
dialog hosted by built-in Windows PowerShell on Windows, or from the hidden terminal
reader on other platforms, and must match. Both output paths must not exist, and the keypair is published
all-or-nothing: if the public key cannot be written, the private key file is removed, so a
half-published keypair is never left behind.

**What protects the private key.** The passphrase, on every platform. It is the only
protection this command provides and the only one it claims. Both key files and the
receipt are created with mode `0600`, and what that argument achieves is not the same
thing on every platform:

| platform | measured | what it means |
|---|---|---|
| POSIX | `0600` | owner-read/write, enforced by the filesystem |
| Windows | `0666` | **not** an access control; it restricts nobody |

On Windows, Node maps only the owner-write bit to the read-only attribute, so the numeric
mode carries no access control at all and the file inherits the ACL of the directory it
was created in. **Placement and ACL policy are therefore the operator's**: put the key
somewhere only the operator's account can read, not beside the checkout. This command
installs no ACL and will not pretend to — an unreviewed ACL manager in the middle of the
authority seam would be a larger risk than the one it closes.

`tests/github-portfolio-operator.test.mjs` measures all three files on whichever platform
it runs on and asserts that platform's row, so the table cannot drift from the product
silently. Note what that means for the Windows row: widening the mode there changes
nothing measurable, because there was nothing there to widen.

The passphrase is never accepted from `argv`, from the environment, from prompt text, or
from a file in the repository. `init` refuses when stdin is not an interactive terminal.
On Windows the CLI opens a masked, top-most OS dialog through built-in Windows PowerShell
and receives one bounded canonical base64 response over a private child stdout pipe; the
child has no stdin. Cancel, window close, helper failure, and output overflow all settle as
typed refusals; overflow terminates the helper instead of waiting for it. On other
platforms the existing raw terminal reader remains in use.

### `run`

```
node scripts/github-portfolio-operator.mjs run \
  --portfolio     ../state/gaia-github-portfolio.json \
  --repository    OWNER/NAME \
  --private-key   ../state/gaia-operator.key \
  --public-key    ../state/gaia-operator.pub \
  --ledger        ../state/gaia-operator-ledger \
  --worktree      ../candidate-worktree \
  --evidence-root ../state/gaia-operator-evidence \
  --out           ../state/gaia-operator-receipt.json \
  [--ttl-seconds 120]
```

`--repository` is a pre-commitment: the operator states which repository they are willing
to authorize before the intent is known, and the execution adapter refuses any intent that
names another one. The pinned `--portfolio` file is a revision, not a plan: GitHub is
re-read and the portfolio rebuilt, and a revision mismatch is a refusal, never a fresh
selection.

The confirmation prompt shows the repository, item kind, item number, item id, action, the
full intent revision, the snapshot revision, and last, on its own labelled line, the
GitHub title carried as untrusted data. **Every one of those fields is GitHub-derived and
every one goes through the same display control**: control characters, line and paragraph
separators, and bidirectional formatting are replaced, and the field is truncated at 256
code points. Two fields are already safe by other means — `repository` was pinned to the
operator's own `--repository` before the block could be built, and the intent revision is
a digest this command measured — and they are sanitized anyway, because naming an
exception is how a field gets added later without anyone deciding about it. The item id is
the one that makes the case: the portfolio bounds a *title* to one canonical line at
survey but constrains an id no further than "it is a string", and these are the lines the
operator is being asked to judge.

The operator must type the full 64-character intent revision; anything else — including
the revision of a different intent — refuses.

### Leaving the prompt without answering it

End of input and Ctrl-C are **explicit refusals** at the terminal confirmation prompt.
The non-Windows terminal passphrase reader treats Ctrl-D and Ctrl-C likewise; the Windows
dialog has explicit OK and Cancel paths, and closing it is Cancel. A broken interactive
reader also refuses. Each path settles the read, leaves a structured receipt naming what
happened, spends no authority, and exits `1`.
Neither reader has a timeout and neither may grow one: waiting for a person is not a
failure, and a deadline at these prompts would be a way for the command to decide
something the operator did not.

Exit codes: `0` when the factory ran and returned a verdict — `transition.status` is
`CANDIDATE_READY` or `CANDIDATE_REJECTED`; `1` for every refusal, for a cancelled prompt,
and for a spent grant whose execution failed; `2` for a usage error raised before the
output path was reserved.

## Receipt

`run` writes exactly one JSON document to `--out`, reserved exclusively (`wx`) before
authority is consumed:

```
{
  "schema": "gaia-github-portfolio-operator-receipt/1",
  "status": "REFUSED" | "AUTHORIZED",
  "portfolioRevision": "<sha256>",
  "repository": "OWNER/NAME",
  "intent": { action, repository, itemKind, itemId, itemNumber, intentRevision } | null,
  "refusal": { "stage": "...", "code": "..." } | null,
  "transition": <portfolio transition> | null,
  "revision": "<sha256 of this body>"
}
```

`REFUSED` means no grant was consumed and nothing executed. `AUTHORIZED` means the grant
was consumed exactly once; `transition.status` then reports `CANDIDATE_READY`,
`CANDIDATE_REJECTED`, or `EXECUTION_FAILED`. A refusal carries a stage and a short code
only — never a provider message, a passphrase, a signature, or key material. Nothing the
command writes to the receipt or to stdout contains the grant signature, the private key,
or the passphrase.

The terminal prompts refuse under codes of their own, so the receipt says which thing
happened rather than blaming the key for a decision the operator made:

| stage | code | what happened |
|---|---|---|
| `confirm` | `ConfirmationMismatch` | something other than this intent's revision was typed |
| `confirm` | `ConfirmationClosed` | the prompt reached end of input before an answer |
| `confirm` | `ConfirmationCancelled` | Ctrl-C at the prompt |
| `confirm` | `ConfirmationUnreadable` | the terminal stream broke under the read |
| `key` | `PassphraseCancelled` | Ctrl-C at a non-Windows terminal prompt, or Cancel/window close in the Windows dialog |
| `key` | `PassphraseClosed` | the non-Windows terminal prompt reached end of input |
| `key` | `PassphraseUnreadable` | the terminal stream or Windows dialog helper broke, overflowed, or returned malformed output |
| `key` | `PrivateKeyUnreadable` | the passphrase was answered and did not open the key |

The scope of "every exit leaves a receipt" is exact: every path on which
`runOperatorFactory` **returns** writes one, and after the reservation every terminal
condition is a return rather than a throw. The residue is the write itself — if the
receipt write fails after authority is spent (`ENOSPC`, `EIO`, a lock), the exception
escapes and the process exits `2`. That window is not closed here.

## What this command cannot do

It performs no GitHub mutation of any kind: no commit, push, publish, merge, issue
assignment, or comment. It adds no bus verb, touches no global configuration, and changes
no credential. Its only writes are the two key files `init` creates, the single receipt
`run` reserves, and the evidence and ledger entries the existing execution and authority
adapters already own.
