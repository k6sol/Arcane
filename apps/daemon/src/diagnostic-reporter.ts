import {randomUUID} from 'node:crypto';
import type {DiagnosticEvent} from '../../../packages/diagnostics/src/report.js';
import {diagnosticEvent, diagnosticEventId, DIAGNOSTIC_EXCEPTIONS, DIAGNOSTIC_REASONS, DIAGNOSTIC_STAGES} from '../../../packages/diagnostics/src/report.js';
import type {AssetJobError} from '../../../packages/asset-pipeline/src/types.js';

export interface DiagnosticChannel {
  connected?: boolean;
  send?(message: unknown, callback: (error: Error | null) => void): boolean;
  on(event: 'message', callback: (message: unknown) => void): unknown;
  removeListener(event: 'message', callback: (message: unknown) => void): unknown;
}
export type FailureReporter = (event: DiagnosticEvent) => Promise<string | null>;
/** Only safe decoded fields enter the report. Raw messages, paths and worker output remain in existing local evidence. */
export function assetFailureEvent(jobId: string, error: AssetJobError, occurredAt = Date.now()): DiagnosticEvent {
  const d = error.diagnostic, raw = d?.reasonCode ?? error.code;
  const code = error.code === 'DEADLINE' ? 'REQUEST_TIMEOUT' : error.code === 'CANCELLED' ? 'OPERATION_CANCELLED' :
    ['SUPERVISION_UNRESOLVED','SUPERVISION_LOST'].includes(error.code) ? 'SUPERVISION_LOST' :
    Object.hasOwn(DIAGNOSTIC_REASONS, raw) ? raw as DiagnosticEvent['code'] : 'INTERNAL_ERROR';
  const stage = d?.stage && (DIAGNOSTIC_STAGES as readonly string[]).includes(d.stage) ? d.stage as DiagnosticEvent['stage'] : 'generate';
  const context: Record<string, unknown> = {jobId};
  if (d?.exceptionType && (DIAGNOSTIC_EXCEPTIONS as readonly string[]).includes(d.exceptionType)) context.exceptionType = d.exceptionType;
  if (d?.metrics) for (const key of ['renderTriangles', 'triangleBudget', 'collisionTriangles', 'invalidMeshes', 'errorCount']) {
    const value = d.metrics[key]; if (Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 1e9) context[key] = value;
  }
  return diagnosticEvent({schemaVersion: 1, eventId: randomUUID(), occurredAt, component: 'blender', stage, code, context});
}
/** Fixed private child-parent protocol. A send() boolean is not a durable acknowledgement. */
export function createDiagnosticReporter(channel: DiagnosticChannel = process, timeoutMs = 1000): {report: FailureReporter; close(): void} {
  const pending = new Map<string, {eventId: string; finish: (value: string | null) => void}>(); let closed = false;
  const listener = (message: unknown) => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return;
    const v = message as Record<string, unknown>;
    if (Object.keys(v).sort().join(',') !== 'eventId,protocolVersion,requestId,stored,type' || v.type !== 'arcane-diagnostic-ack' || v.protocolVersion !== 1 ||
        !diagnosticEventId(v.requestId) || typeof v.stored !== 'boolean') return;
    const request = pending.get(v.requestId); if (!request || v.eventId !== request.eventId) return;
    request.finish(v.stored ? request.eventId : null);
  };
  channel.on('message', listener);
  async function report(input: DiagnosticEvent): Promise<string | null> {
    let event: DiagnosticEvent; try {event = diagnosticEvent(input);} catch {return null;}
    if (closed || !channel.send || channel.connected === false || pending.size >= 16) return null;
    const requestId = randomUUID();
    return new Promise(resolve => {
      let done = false;
      const finish = (value: string | null) => {if (done) return; done = true; clearTimeout(timer); pending.delete(requestId); resolve(value);};
      const timer = setTimeout(() => finish(null), timeoutMs);
      pending.set(requestId, {eventId: event.eventId, finish});
      try {channel.send!({type: 'arcane-diagnostic-report', protocolVersion: 1, requestId, event}, error => {if (error) finish(null);});}
      catch {finish(null);}
    });
  }
  return {report, close() {closed = true; channel.removeListener('message', listener); for (const request of [...pending.values()]) request.finish(null);}};
}
