# Inventory-routed reporting

Use this procedure for an official `handoff`, `standards-review`, `spec-review`,
`reconciliation`, `preflight`, or `readiness` artifact.

1. Resolve the lineage's reporting policy before drafting the artifact. Refuse an absent,
   ambiguous, incomplete, or mismatched policy; do not guess whether the lineage is sealed.
2. In unsealed mode, keep ordinary open evidence and call the finalizer without a write capability.
3. In sealed mode, perform the review or reconciliation with all evidence its quality requires.
   Put every detailed observation, diff-derived fact, changed-path vector, and predecessor binding
   in `privateEvidence`. Pass only the trusted composition root's explicitly bound curator write
   function; keep its Adapter object and every readable method outside the finalizer.
4. Publish only the canonical JSON returned by `finalizeInventoryRoutedReport`. Do not add prose,
   tables, paths, counts, or paraphrases around that payload. A bus message may carry the public
   report or its digest; it grants no authority and uses only the existing six verbs.
5. Treat a typed refusal as the entire public diagnostic. Do not reconstruct private context in an
   error message or retry through a different document class.

The sealed write order is private evidence, then the existing lineage manifest, then the returned
public commitment. A failure after the first write may leave an unreferenced private object; it
must never produce a partial public artifact.

The captured write function is a capability seam, not proof of operating-system isolation or
authentication. The finalizer owns a canonical copy of the request before its first write, but
curator-only access is still supplied by the deployment boundary. The curator, Standards reviewer,
and Spec reviewer are distinct roles, and a producer is never the curator.

The sealed class list is closed in policy version 1. A future artifact class requires a new policy
digest and activation receipt before sealing; it must not be smuggled through an existing class.
