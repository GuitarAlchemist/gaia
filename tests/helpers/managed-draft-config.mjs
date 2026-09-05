const OPERATION_ID = 'a'.repeat(64);
const WORK_KEY = 'b'.repeat(64);
const HEAD = '9'.repeat(40);
const SUPERVISOR = `gaia:operation:${OPERATION_ID}`;
const EXECUTION = `gaia:lane:${WORK_KEY}:${HEAD}`;
export const MANAGED_CREATE = Object.freeze({
  receipt: {
    schema:'GaiaRoundReceiptV0', kind:'OPEN', revision:'f'.repeat(64), ordinal:0,
    predecessorRoundKey:'NONE', trigger:'DRAFT_CREATED', roundBudget:2,
    responsibility:{
      ownershipRevision:'1'.repeat(64), accountableOwner:'github:user:test-owner',
      supervisor:SUPERVISOR, executionOwner:EXECUTION, reportsTo:SUPERVISOR,
      reviewOwners:{standards:'github:user:test-standards',spec:'github:user:test-spec'},
      effectOwner:'github:app:gaia-draft-pump', escalatesTo:'github:user:test-owner',
    },
    command:{commandRevision:'2'.repeat(64),commandOwner:SUPERVISOR,
      commandPath:[SUPERVISOR,EXECUTION],generation:HEAD,
      capabilities:['ASSIGN','REVOKE','STOP','RETRY','ESCALATE']},
    evidence:{designCommit:'UNKNOWN(NOT_REACHED)',redCommit:'UNKNOWN(NOT_REACHED)',
      greenCommit:'UNKNOWN(NOT_REACHED)',testEvidenceReceipt:'UNKNOWN(NOT_REACHED)',
      reviewVerdicts:['UNKNOWN(NOT_REACHED)'],result:'IN_PROGRESS',nextStep:'Validate intake',
      estimate:{range:'UNKNOWN(NOT_MEASURED)',confidence:'UNKNOWN(NOT_MEASURED)',origin:'test fixture'},
      blocker:{class:'NONE',reason:'No known blocker',owner:'github:user:test-owner',
        phaseDeadline:'2026-09-05T15:30:00.000Z',nextTransition:'R0_CREATE_PROVEN',
        escalationAction:'REPORT_BLOCKER',origin:'test fixture'},origin:'test fixture'},
  },
  effectActor: 'github:app:gaia-draft-pump',
  effectClaim: { schema:'GaiaManagedRoundEffectClaimV0',revision:'3'.repeat(64),claimId:'1'.repeat(64),
    observedAt:'2026-09-05T15:00:00.000Z',leaseExpiresAt:'2026-09-05T15:05:00.000Z' },
});
