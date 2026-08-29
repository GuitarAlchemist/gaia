// THROWAWAY PROTOTYPE — not production code.
// Question: can an exact path allowlist plus before/after measurement make a Pi
// writer useful while failing closed on every observed mutation outside scope?

export function initialState() {
  return {
    allowedPaths: ['src/allowed.mjs'],
    observedChanges: [],
    status: 'COLLECTING',
    reason: null,
  };
}

export function transition(state, action) {
  if (action.type === 'reset') return initialState();
  if (state.status !== 'COLLECTING') return state;
  if (action.type === 'observe') {
    return { ...state, observedChanges: [...state.observedChanges, action.change] };
  }
  if (action.type !== 'validate') return state;

  const unsafe = state.observedChanges.find((change) => (
    !state.allowedPaths.includes(change.path) || change.kind !== 'file'
  ));
  if (unsafe) {
    return {
      ...state,
      status: 'REFUSED',
      reason: unsafe.kind !== 'file' ? 'UNSAFE_PATH_TYPE' : 'PATH_OUTSIDE_ALLOWLIST',
    };
  }
  return {
    ...state,
    status: state.observedChanges.length === 0 ? 'REFUSED' : 'ACCEPTED',
    reason: state.observedChanges.length === 0 ? 'NO_CANDIDATE_CHANGE' : null,
  };
}
