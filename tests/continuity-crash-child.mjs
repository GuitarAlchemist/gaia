import { createContinuityController } from '../src/continuity-controller.mjs';
import { openContinuityStore } from '../src/continuity-store.mjs';
import { writeSync } from 'node:fs';

process.once('message', ({ mode = 'post-commit', path, command, clockEpoch, candidateUtc }) => {
  const store = openContinuityStore({ path, clockEpoch, clock: () => candidateUtc });
  if (mode === 'pre-commit') {
    store.runOperation({
      operationId: command.operationId,
      requestDigest: 'b'.repeat(64),
      transition: ({ mintTime }) => {
        mintTime();
        writeSync(1, 'TRANSACTION_OPEN\n');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2_147_483_647);
      },
    });
    return;
  }
  const controller = createContinuityController({ store });
  controller.acceptGeneration0Bytes(command);
  // Deliberately expose only the commit boundary, not the operation response.
  process.send?.({ type: 'commit-complete-response-withheld' });
  setInterval(() => {}, 1_000).unref();
});
