# Holdout-safe reporting — doctrine

**Status: normative doctrine. Not a control, and not machine-enforced.**

This document tells a curator, a reviewer and a decision-maker what may and may not appear in an
open document about a lineage that has been declared sealed. Nothing in this repository checks that
you obeyed it. A shipped gate checks that this file exists, that the skill points at it, and that it
still states the two rules below; no gate can check the prose you write, and calling this a control
would be exactly the dishonesty it forbids.

It is doctrine because the leak channel it covers — a human writing a sentence — has no
machine-checkable observable. A control whose failure mode is "nothing happens" is not a control.
That is stated here, in the doctrine itself, so no later reader mistakes its scope.

## 1. The one rule

**A quantity leaks if it is a function of both revisions.** A quantity is safe if it is a function
of one revision, or of neither.

That single sentence decides every field of every open document. It is short on purpose: it has to
be followable from memory by a lane that will never read the rest of this file.

The corollary, for prose rather than fields: **open prose may describe the revision, never the
difference.** Write a *forward* scope statement — what the successor contains, what each module is
for, which behaviours it asserts — never a statement about what changed relative to a predecessor.

## 2. Why the rule exists

A holdout population is useful only while its labels are unknown to the lane that will evaluate it.
For a per-file population over a revision pair, the label vector *is* the changed/unchanged split.
Under ordinary review practice the procedure that entitles a population to be evaluated — an
independent Standards review and an independent Spec review, each showing it measured something —
is the same procedure that publishes that split. Entitlement and unexposedness become mutually
exclusive, and the population is burned by the act that entitles it.

Once a population's defect count, identifiers, drift shape and identical/differing split are
published, no procedure recovers its unseen status. There is no repair. That is why the obligation
here is prospective and absolute rather than a matter of degree.

## 3. Sealed versus unsealed reporting

**Unsealed is the default and nothing about it changes.** Ordinary review work — diffs,
changed-path tables, diff stats, before/after byte counts — continues exactly as today. This
doctrine imposes no cost on a lineage nobody has sealed.

**Sealed** is a per-lineage declaration made by the curator, in advance, and it changes what may be
written down:

| | Unsealed lineage | Sealed lineage |
|---|---|---|
| Cross-revision quantities in open documents | permitted | **forbidden** |
| Where cross-revision quantities go | anywhere | the curator's sealed store, and nowhere else |
| Scope statement in a review | may be a diff | written forward, about the successor alone |
| Continuity (that the successor succeeds the predecessor) | attested by the reviewer | attested by the curator, not the reviewer |

The obligation covers **every open document class**, not a fixed list: handoffs, Standards reviews,
Spec reviews, milestone reconciliations, preflights, readiness reports, bus message bodies, commit
messages, and any class invented after this file was written. The test is not "is it on the list"
but: **could a future evaluator be obliged to read this document?** If yes, it is an open document
and this doctrine binds it.

## 4. Prohibited in any open document about a sealed lineage

- Do not publish the path-level changed/unchanged vector, in any encoding, in whole or in part.
- Do not publish the changed count, the unchanged count, or added / removed / renamed counts.
- Do not publish changed-path names, nor unchanged-path names asserted as unchanged.
- Do not publish per-file before/after byte counts, a diff line count, or a diff stat summary.
- Do not publish per-file changed/unchanged booleans, or any table whose row count tracks them.
- Do not publish "the change is confined to X" or "Y is byte-identical across the repair".
- Do not publish **the pairing itself** — which predecessor this successor descends from.
- Do not publish any quantity whose *size* tracks the size of the change. If a reader can infer
  "this was a big change" from your document, your document leaked the cardinality even though it
  named no path.

The last item is the one most often missed. Invariance of field set and document length to the size
of the change is part of the rule, not a refinement of it.

## 5. Permitted in an open document about a sealed lineage

Every item here is a measurement over **one** revision, or over no revision at all:

- The successor's own `inventory-digest/1` fixed point: file count, byte total, digest — always
  reported together with the recipe name, because a bare hex string cannot later be reproduced.
- That revision's cleanliness measurements: read-only attribute, reparse-point count,
  alternate-stream count, porcelain line count.
- That revision's own test totals: passed, failed, deterministic repeats, mutations total,
  mutations discriminating. A mutation sweep is a property of one tree and survives sealing intact.
- Findings phrased as statements about what the revision **does**, never about what it changed.
- Document digests; evidence items as `{label, digest}` where the label is a bounded identifier and
  never a path; the preregistration digest; the lineage identifier; the verdict.

A transcript that mentions no cross-revision quantity may be published openly. A transcript that
enumerates changed paths — a version-control log, a diff-driven test selection — is routed to the
sealed store. Classifying transcripts is the one recurring human judgement this doctrine cannot
remove.

## 6. Snapshot-review precondition

A sealed lineage's revisions must be reviewed as **snapshot trees, not as a commit range** in a
repository every reviewer clones. This is a **precondition** of sealed mode, not a stylistic
preference: if both revisions sit in one cloned history, the changed/unchanged vector is one
command away for every reviewer, and sealing the reporting surface protects almost nothing.

Declare the precondition satisfied before declaring the lineage sealed. A lineage that cannot meet
it should not be sealed, and claiming a seal over it would misdescribe the protection actually
obtained.

## 7. Forward-only sealing

Sealing is **forward-only**. A seal executed after the successor exists, or after any inventory has
been published, restores nothing. The seal's entire function is to fix the case-selection space at a
moment when the label vector is not yet knowable to anyone; a seal that postdates knowability is a
timestamp on a fact, not a control.

Therefore: **retrospective sealing is forbidden.** Burned lineages stay burned. This doctrine offers
no retrofit path and must not be read, quoted, or implemented as offering one. Any future tool that
appears to offer one should be rejected on that ground alone.

## 8. Publication, not computability

**Publication is the controlled risk. Computability is not claimed away.**

Anyone holding both revisions can compute the vector in one command, and no doctrine, module or seal
prevents that. What sealing changes is the *character* of exposure: from obligatory and unenumerable
— every lane obliged to read the approved evidence becomes exposed, and the readership of a
published document is unbounded and unrecorded — to voluntary and partly enumerable, where a lane
becomes exposed only by deliberately opening the sealed store or deliberately diffing two revisions.

The property obtained is **evidentiary, not cryptographic**. State it that way every time. A claim
that no open document contains a label vector is an unprovable negative; record it as unknown, do
not assert it.

## 9. Authority boundaries

No artifact and no document mentioned here grants authority. Each **records** a fact or a decision
made elsewhere, under someone's own authority.

| Role | May | May not |
|---|---|---|
| **Curator** | hold both revisions; declare a lineage sealed before the successor exists; route cross-revision material to the sealed store | evaluate the population — a curator holds the vector by construction |
| **Decision-maker** | release sealed material to a named reader, producing one append-only record naming reader and released digest | confer any capability by releasing; the record unlocks nothing |
| **Reviewer** | review the successor on its own terms and render a verdict under their own authority | attest the relationship between successor and predecessor; read the seal, except after a release, which permanently removes them from the evaluator pool |
| **Evaluator** | hold frozen identities; read the corpus once | read the seal, ever — reading disqualifies |
| **Process owner** | author and amend this doctrine | change any behaviour by amending it |

Reading a seal is an **exposure event, not a privilege escalation**. It grants nothing; its only
effect is to move the reader permanently out of the evaluator pool. Minting a seal is exclusively
the curator's act; release is exclusively the decision-maker's.

The bus enforces none of this. It carries digests as untrusted text and proves delivery only. Its
surface remains exactly `register`, `send`, `inbox`, `ack`, `heartbeat`, `handoff`; a design that
finds it needs a seventh verb to make sealing work is evidence that the design is wrong, not that
the bus is incomplete.

## 10. Reviewer behaviour

If you are reviewing a revision of a sealed lineage:

1. Review the successor. Do not request the predecessor, and do not fetch it if you can avoid it.
2. Recompute the successor's fixed point yourself from the tree you hold, and cite it with its
   recipe. A review that cannot show it measured something has verified nothing.
3. Write the scope statement forward. Describe what exists and what it is for. If a sentence needs
   the word "changed", "still", "unchanged", "now", "no longer", or "as before" to make sense, it is
   probably a cross-revision statement wearing prose.
4. Report tests and cleanliness as totals over your one tree.
5. Do not attest continuity. That the successor really descends from the predecessor is discharged
   by the curator, not by you. Say so in your review rather than implying you checked it.
6. If you cannot render a verdict without the diff, **say that in the review and stop**. That is a
   real finding about this doctrine, not a failure on your part — see §13.

If you are writing any other open document — a handoff, a reconciliation, a message body — apply §4
and §5 unchanged. The document class does not matter; the obligation to a future evaluator does.

## 11. Fail-closed behaviour

When something is ambiguous, the safe direction is to **write less and refuse rather than publish**.

- If you are unsure whether a quantity is cross-revision, treat it as cross-revision.
- If you are unsure whether a lineage is sealed, treat it as sealed until the curator says otherwise.
- If you are unsure whether a document is open, treat it as open.
- If a seal, a store or a release record is missing, damaged or contradictory, stop and report it.
  Produce no partial document; a partial open document is still a published one.
- A refusal produces no artifact on any path and no diagnostic quoting a path from either revision.
  Error text is an open document too.

There is no state in which publishing a doubtful quantity is the recoverable choice. Refusing costs
a round trip; publishing costs the population permanently.

## 12. Residual UNKNOWNs

These are open, and this doctrine does not close them. Each is recorded so it cannot later be
mistaken for a settled property.

- **`UNKNOWN{ReviewSufficiencyUnderSeal}`** — whether two independent reviewers can render a
  trustworthy verdict from a single-revision receipt alone. Untested. Gate: §13.
- **`UNKNOWN{ExposureEnumerability}`** — whether exposure is enumerable in practice, given that any
  holder of both revisions can re-derive the vector without registering. A release register is a
  list of names, never a list of labels, and is partial evidence, never an invariant.
- **`UNKNOWN{ExposureProofCompleteness}`** — whether it can be shown that no open document carries a
  label vector. It cannot be proven; it is recorded as unknown rather than asserted.
- **`UNKNOWN{OpenDocumentClassClosure}`** — whether the open document classes are enumerable at all.
  The list has already grown once. This is why §3 states a rule rather than only a list.
- **Review-quality cost** — whether sealed-mode review is measurably *worse* on revisions where the
  diff was the reviewer's primary instrument. Distinct from sufficiency: not that a verdict is
  impossible, but that it is degraded. To be measured, not assumed away.

## 13. Required stop gate before any module is built

**No lineage-receipt module, sealed store, manifest writer, exposure register or command-line tool
may be implemented until the review-sufficiency experiment has been run and its result recorded.**

The order is fixed, and the order matters more than the design:

1. This doctrine, and the skill pointer to it. *(This step.)*
2. The snapshot-review precondition of §6, declared.
3. **The review-sufficiency experiment.** Two independent reviewers, working from an already-burned
   revision and a public single-revision receipt alone, each attempt a verdict. Run it on an
   already-spent lineage, where the experiment costs nothing because the population is already
   burned. Record the outcome whichever way it goes.
4. Only then, if the experiment passes: the module, written test-first, under its own independent
   Standards and Spec review, by an author who is not the reviewer.
5. Only then: a curator constituted, and a first seal minted.

Step 3 is a genuine decision point. **If the reviewers report that a single-revision receipt is
insufficient for a trustworthy verdict, stop.** Building the module anyway would trade a real
control — independent review — for a statistical property the module cannot deliver on its own.

## 14. What this doctrine does not do

It does not approve, advance or unblock any milestone. It does not authorize any run, admission,
seal, release or publication. It does not make any population eligible. It does not restore unseen
status to any burned lineage. It does not prove that any open document is free of a label vector. It
does not prevent anyone holding two revisions from computing the diff. It adds no bus verb and
widens none. It changes no digest recipe. It constitutes no curator, reviewer or evaluator.

It is a rule that people have to follow, written down so that following it is possible.
