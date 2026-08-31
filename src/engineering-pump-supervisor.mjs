/** R0 public seam. The RED commit deliberately carries no behavior. */

export const ENGINEERING_PUMP_OBSERVATION_SCHEMA = 'gaia-engineering-pump-observation/1';

const pending = () => {
  const error = new Error('engineering pump supervisor R0 is not implemented');
  error.code = 'NotImplemented';
  throw error;
};

export const sealEngineeringPumpObservation = pending;
export const runEngineeringPumpSupervisorTick = pending;
export const projectEngineeringPumpChecklist = pending;
export const projectEngineeringPumpTransitions = pending;
