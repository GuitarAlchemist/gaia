import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createFactoryTracer,
  createLoopbackOtlpTraceSink,
} from '../src/factory-tracing.mjs';

test('the loopback sink emits one literal OTLP HTTP span without task or provider text', async () => {
  const calls = [];
  const sink = createLoopbackOtlpTraceSink({
    endpoint: 'http://127.0.0.1:4318/v1/traces',
    fetchImpl: async (...args) => {
      calls.push(args);
      return { ok: true, status: 200 };
    },
  });

  await sink.record({
    traceId: '11'.repeat(16),
    spanId: '22'.repeat(8),
    name: 'gaia.factory.worker',
    startTimeUnixNano: '1000000',
    endTimeUnixNano: '2000000',
    attributes: {
      'gaia.cost_policy': 'ZERO_ADDITIONAL_DOLLARS',
      'gaia.authority_effect': 'NONE',
    },
    status: 'OK',
  });

  assert.equal(calls.length, 1);
  assert.equal(String(calls[0][0]), 'http://127.0.0.1:4318/v1/traces');
  assert.equal(calls[0][1].method, 'POST');
  assert.equal(calls[0][1].redirect, 'error');
  const payload = JSON.parse(calls[0][1].body);
  const span = payload.resourceSpans[0].scopeSpans[0].spans[0];
  assert.deepEqual({
    traceId: span.traceId,
    spanId: span.spanId,
    name: span.name,
    startTimeUnixNano: span.startTimeUnixNano,
    endTimeUnixNano: span.endTimeUnixNano,
    status: span.status,
  }, {
    traceId: '11'.repeat(16),
    spanId: '22'.repeat(8),
    name: 'gaia.factory.worker',
    startTimeUnixNano: '1000000',
    endTimeUnixNano: '2000000',
    status: { code: 1 },
  });
  assert.doesNotMatch(calls[0][1].body, /task|provider|prompt|output/iu);
});

test('the OTLP adapter refuses every non-loopback destination', () => {
  for (const endpoint of [
    'https://127.0.0.1:4318/v1/traces',
    'http://localhost:4318/v1/traces',
    'http://user:password@127.0.0.1:4318/v1/traces',
    'http://127.0.0.1:4318/not-traces',
    'http://collector.example.com/v1/traces',
    'https://telemetry.example.com/v1/traces',
  ]) {
    assert.throws(
      () => createLoopbackOtlpTraceSink({ endpoint }),
      /explicit HTTP loopback address/u,
    );
  }
});

test('the tracer closes attributes to phase, zero cost, and no authority', async () => {
  const observations = [];
  const tracer = createFactoryTracer({
    sink: { record: async (span) => { observations.push(span); } },
    traceId: 'aa'.repeat(16),
    spanId: () => 'bb'.repeat(8),
    clock: (() => {
      const values = [1n, 2n];
      return () => values.shift();
    })(),
  });

  await tracer.span('secret task embedded in span name', {
    'gaia.phase': 'cycle',
    'gaia.cost_policy': 'PAY_AS_YOU_GO',
    'gaia.authority_effect': 'ALL',
    task: 'secret task text',
  }, async () => 'completed');

  assert.deepEqual(observations[0].attributes, {
    'gaia.phase': 'cycle',
    'gaia.cost_policy': 'ZERO_ADDITIONAL_DOLLARS',
    'gaia.authority_effect': 'NONE',
  });
  assert.equal(observations[0].name, 'gaia.factory.unknown');
});

test('a telemetry failure cannot change the factory operation result', async () => {
  const tracer = createFactoryTracer({
    sink: { record: async () => { throw new Error('collector unavailable'); } },
    traceId: 'aa'.repeat(16),
    spanId: () => 'bb'.repeat(8),
    clock: (() => {
      const values = [1n, 2n];
      return () => values.shift();
    })(),
  });

  assert.equal(await tracer.span('gaia.factory.cycle', {}, async () => 'completed'), 'completed');
});
