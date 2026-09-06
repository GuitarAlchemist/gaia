// Assignment identity only. A valid identifier is not authentication or an APPROVE.
const AGENT = /^gaia:agent:v1:([a-z][a-z0-9-]{0,31}):([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}):([A-Za-z0-9_][A-Za-z0-9_./-]{0,95})$/u;

/** Same session/agent cannot gain independence by changing its provider label. */
export function independentAgentReviewers(writerIdentity, reviewOwners) {
  const identities = [writerIdentity, reviewOwners?.standards, reviewOwners?.spec];
  const actors = identities.map(value => {
    const match = typeof value === 'string' ? AGENT.exec(value) : null;
    return match ? `${match[2]}:${match[3]}` : null;
  });
  return actors.every(actor => actor !== null) && new Set(actors).size === 3;
}
