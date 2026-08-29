import { randomBytes } from 'node:crypto';

const BASE_ATTRIBUTES = Object.freeze({
  'gaia.cost_policy': 'ZERO_ADDITIONAL_DOLLARS',
  'gaia.authority_effect': 'NONE',
});
const PHASES = new Set(['cycle', 'worker', 'initial_review', 'repair', 'final_review']);
const SPAN_NAMES = new Set([...PHASES].map((phase) => `gaia.factory.${phase}`));

const id = (bytes) => randomBytes(bytes).toString('hex');
const nowNanoseconds = () => BigInt(Date.now()) * 1_000_000n;

function otlpValue(value) {
  if (typeof value === 'boolean') return { boolValue: value };
  if (typeof value === 'number') return { doubleValue: value };
  return { stringValue: String(value) };
}

function otlpSpan(span) {
  return {
    traceId: span.traceId,
    spanId: span.spanId,
    ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
    name: span.name,
    kind: 1,
    startTimeUnixNano: span.startTimeUnixNano,
    endTimeUnixNano: span.endTimeUnixNano,
    attributes: Object.entries(span.attributes).map(([key, value]) => ({
      key, value: otlpValue(value),
    })),
    status: { code: span.status === 'OK' ? 1 : 2 },
  };
}

export function createLoopbackOtlpTraceSink({
  endpoint,
  fetchImpl = globalThis.fetch,
  timeoutMs = 2_000,
} = {}) {
  const url = new URL(endpoint);
  const loopback = new Set(['127.0.0.1', '[::1]']);
  if (url.protocol !== 'http:' || !loopback.has(url.hostname)
      || url.username !== '' || url.password !== ''
      || url.pathname !== '/v1/traces' || url.search !== '' || url.hash !== '') {
    throw new TypeError('OTLP endpoint must be an explicit HTTP loopback address');
  }
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');
  return Object.freeze({
    async record(span) {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          resourceSpans: [{
            resource: { attributes: [{
              key: 'service.name', value: { stringValue: 'gaia-agent-factory' },
            }] },
            scopeSpans: [{
              scope: { name: 'gaia.factory', version: '1' },
              spans: [otlpSpan(span)],
            }],
          }],
        }),
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`OTLP collector refused span with ${response.status}`);
    },
  });
}

export function createFactoryTracer({
  sink,
  traceId = id(16),
  parentSpanId = null,
  clock = nowNanoseconds,
  spanId = () => id(8),
} = {}) {
  const record = typeof sink?.record === 'function' ? sink.record.bind(sink) : async () => {};
  return Object.freeze({
    async span(name, attributes, operation) {
      const currentSpanId = spanId();
      const started = clock();
      let status = 'OK';
      try {
        return await operation(createFactoryTracer({
          sink, traceId, parentSpanId: currentSpanId, clock, spanId,
        }));
      } catch (error) {
        status = 'ERROR';
        throw error;
      } finally {
        const observation = Object.freeze({
          traceId,
          spanId: currentSpanId,
          ...(parentSpanId ? { parentSpanId } : {}),
          name: SPAN_NAMES.has(name) ? name : 'gaia.factory.unknown',
          startTimeUnixNano: String(started),
          endTimeUnixNano: String(clock()),
          attributes: Object.freeze({
            'gaia.phase': PHASES.has(attributes?.['gaia.phase'])
              ? attributes['gaia.phase'] : 'unknown',
            ...BASE_ATTRIBUTES,
          }),
          status,
        });
        try {
          await record(observation);
        } catch {
          // Telemetry is observation only and never changes execution outcome or authority.
        }
      }
    },
  });
}

export function instrumentFactoryTraceAdapters({
  runWorker, runReviewer, runRepair, tracer,
}) {
  let reviewRound = 0;
  return Object.freeze({
    runWorker: (...args) => tracer.span(
      'gaia.factory.worker', { 'gaia.phase': 'worker' }, () => runWorker(...args),
    ),
    runReviewer: (...args) => {
      const phase = reviewRound === 0 ? 'initial_review' : 'final_review';
      reviewRound += 1;
      return tracer.span(
        `gaia.factory.${phase}`, { 'gaia.phase': phase }, () => runReviewer(...args),
      );
    },
    runRepair: (...args) => tracer.span(
      'gaia.factory.repair', { 'gaia.phase': 'repair' }, () => runRepair(...args),
    ),
  });
}
