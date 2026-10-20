import test from 'node:test';
import assert from 'node:assert/strict';
import {diagnosticEvent, DiagnosticValidationError, DIAGNOSTIC_REASONS} from '../../packages/diagnostics/src/report.js';

const input = {schemaVersion: 1, eventId: '8e6bc8a1-a0ea-4823-8998-0f82d14469ba', occurredAt: 1792500000000,
  component: 'blender', stage: 'texture-authoring', code: 'MEMORY_LIMIT', context: {exceptionType: 'MemoryError', exitCode: 1, triangleBudget: 16000}};
test('a report identifies the real failing stage, safe exception class and useful numeric context', () => {
  const event = diagnosticEvent(input);
  assert.equal(event.stage, 'texture-authoring'); assert.equal(event.code, 'MEMORY_LIMIT');
  assert.equal(event.reason, DIAGNOSTIC_REASONS.MEMORY_LIMIT); assert.equal(event.context?.triangleBudget, 16000);
  assert.deepEqual(diagnosticEvent(JSON.parse(JSON.stringify(event))), event);
  assert.equal(diagnosticEvent({...input, code: 'INTERNAL_ERROR', context: {exceptionType: 'TypeError'}}).context?.exceptionType, 'TypeError');
});
test('private text cannot enter reports through extra fields, reason, identifiers or context', () => {
  const secret = 'Bearer private-token user@example.com C:\\Users\\private\\script.py prompt text';
  for (const value of [
    {...input, message: secret}, {...input, stack: secret}, {...input, reason: secret}, {...input, prompt: secret},
    {...input, stage: secret}, {...input, code: secret}, {...input, eventId: secret}, {...input, release: secret},
    {...input, context: {path: secret}}, {...input, context: {jobId: secret}}, {...input, context: {exceptionType: secret}},
    {...input, context: {elapsedMs: secret}}, {...input, context: {httpStatus: 999}}, {...input, context: {exitCode: Infinity}},
    {...input, occurredAt: NaN}, {...input, context: {triangleBudget: -1}}, {...input, context: {attempt: 1.5}},
  ]) assert.throws(() => diagnosticEvent(value), (error: unknown) => error instanceof DiagnosticValidationError && !error.message.includes(secret));
});
test('canonical serialization ignores object insertion order without retaining mutable caller context', () => {
  const a = diagnosticEvent(input), b = diagnosticEvent({...input, context: {triangleBudget: 16000, exitCode: 1, exceptionType: 'MemoryError'}});
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  input.context.triangleBudget = 1; assert.equal(a.context?.triangleBudget, 16000);
});
