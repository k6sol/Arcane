import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { isAbsolute, join } from 'node:path';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import { InitializeResultSchema, ListToolsResultSchema, CallToolResultSchema, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';

/** Fixed read-only acceptance protocol against one directly owned MCP process.
 * The caller supplies already checked host paths and a sanitized environment.
 * A private rejecting HTTP endpoint detects unexpected daemon requests. */
export async function checkMcpRuntime({ nodeExecutable, productRoot, workingDirectory, env, expectedTools }) {
  if (![nodeExecutable, productRoot, workingDirectory].every(path => typeof path === 'string' && isAbsolute(path)) ||
      !Array.isArray(expectedTools) || !expectedTools.includes('skills_recommend') || expectedTools.length > 128 ||
      expectedTools.some(name => typeof name !== 'string' || !/^[a-z_]{1,64}(?![\s\S])/.test(name)) || new Set(expectedTools).size !== expectedTools.length) {
    throw new Error('Invalid fixed MCP verification inputs.');
  }
  let requests = 0;
  const sink = createServer((_request, response) => { requests++; response.writeHead(403); response.end(); });
  await new Promise((resolve, reject) => { sink.once('error', reject); sink.listen(0, '127.0.0.1', resolve); });
  try {
    const result = await probe({ nodeExecutable, productRoot, workingDirectory,
      env: { ...env, ARCANE_DAEMON_URL: 'http://127.0.0.1:' + sink.address().port, ARCANE_LOCAL_TOKEN: randomBytes(32).toString('hex') }, expectedTools });
    if (requests !== 0) throw new Error('Read-only MCP verification attempted a daemon request.');
    return { ...result, daemonRequests: requests, inferenceStarted: false, studioOperations: 0 };
  } finally {
    const closed = new Promise(resolve => sink.close(resolve)); sink.closeAllConnections(); await closed;
  }
}

function probe({ nodeExecutable, productRoot, workingDirectory, env, expectedTools }) {
  return new Promise((resolve, reject) => {
    const started = Date.now(), reader = new ReadBuffer({ maxBufferSize: 256 * 1024 });
    let child, phase = 1, outputBytes = 0, trailingBytes = 0, diagnosticBytes = 0, failure = null, finished = false, timer, terminalTimer, drainTimer;
    const diagnostics = createHash('sha256');
    const finish = (code, signal) => {
      if (finished) return; finished = true;
      clearTimeout(timer); clearTimeout(terminalTimer); clearTimeout(drainTimer); reader.clear();
      if (failure || phase !== 4 || trailingBytes !== 0 || code !== 0 || signal !== null || diagnosticBytes !== 0) {
        reject(Object.assign(new Error((failure ?? 'MCP verification did not finish cleanly.') + ' Process exit acknowledged.'),
          { outcome: { pid: child.pid, code, signal, outputBytes, diagnosticBytes } })); return;
      }
      resolve({ tools: expectedTools.length, guidanceRead: true, shutdownVerified: true, code, signal,
        outputBytes, diagnosticBytes, diagnosticSha256: diagnostics.digest('hex'), elapsedMs: Date.now() - started });
    };
    const stop = reason => {
      if (finished || failure) return; failure = reason;
      child.kill();
      terminalTimer = setTimeout(() => {
        if (finished) return; finished = true; clearTimeout(timer); clearTimeout(drainTimer);
        child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy(); reader.clear();
        reject(Object.assign(new Error(reason + ' Terminal acknowledgement missing; inspect the owned process before retrying.'),
          { outcome: { pid: child.pid, outputBytes, diagnosticBytes } }));
      }, 10000);
    };
    const send = message => {
      child.stdin.write(serializeMessage(message), error => { if (error && !finished) stop('MCP request pipe failed.'); });
    };
    const receive = message => {
      if (finished || failure) return;
      if (message.jsonrpc !== '2.0' || message.id !== phase || !('result' in message)) throw new Error('Unexpected MCP response.');
      if (phase === 1) {
        const result = InitializeResultSchema.parse(message.result);
        if (result.serverInfo.name !== 'arcane-studio' || result.protocolVersion !== LATEST_PROTOCOL_VERSION || !result.capabilities.tools) throw new Error('MCP initialization mismatch.');
        phase = 2; send({ jsonrpc: '2.0', method: 'notifications/initialized' });
        send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
      } else if (phase === 2) {
        const result = ListToolsResultSchema.parse(message.result), names = result.tools.map(tool => tool.name).sort();
        if (result.nextCursor || names.length !== expectedTools.length || JSON.stringify(names) !== JSON.stringify([...expectedTools].sort())) throw new Error('MCP inventory mismatch.');
        phase = 3;
        send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'skills_recommend', arguments: {
          request: 'Inspect, plan and verify a local game development task.', limit: 2, byteBudget: 16384, allowExperimental: true,
        } } });
      } else if (phase === 3) {
        const result = CallToolResultSchema.parse(message.result);
        if (result.isError || result.content.length !== 1 || result.content[0]?.type !== 'text') throw new Error('MCP guidance unavailable.');
        const guidance = JSON.parse(result.content[0].text);
        if (guidance.tool !== 'skills_recommend' || guidance.selection !== 'deterministic-task-relevance' || guidance.approvalChanged !== false ||
            guidance.available !== true || !Array.isArray(guidance.ids) || guidance.ids.length < 1 || guidance.ids.length > 2 ||
            guidance.ids.some(id => typeof id !== 'string' || id.length > 64 || !/^arcane-[a-z0-9]+(?:-[a-z0-9]+)*(?![\s\S])/.test(id)) ||
            new Set(guidance.ids).size !== guidance.ids.length ||
            typeof guidance.context !== 'string' || !guidance.context.trim() || !Number.isSafeInteger(guidance.bytes) || guidance.bytes < 1 ||
            guidance.bytes > 16384 || Buffer.byteLength(guidance.context) !== guidance.bytes ||
            JSON.stringify(result.structuredContent) !== JSON.stringify(guidance)) throw new Error('MCP guidance evidence mismatch.');
        phase = 4; child.stdin.end();
      } else throw new Error('Unexpected MCP response after verification.');
    };
    child = spawn(nodeExecutable, [join(productRoot, 'dist/apps/mcp/src/main.js'), '--project', workingDirectory],
      { cwd: workingDirectory, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    timer = setTimeout(() => stop('MCP verification deadline exceeded.'), 15000);
    child.once('spawn', () => send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'arcane-package-verifier', version: '1.0.0' },
    } }));
    child.once('error', () => {
      if (finished) return; finished = true; clearTimeout(timer); clearTimeout(terminalTimer); clearTimeout(drainTimer);
      reject(new Error('Owned MCP process could not be launched.'));
    });
    child.stdin.on('error', () => { if (!finished && phase !== 4) stop('MCP request pipe failed.'); });
    child.stdout.on('data', chunk => {
      if (finished || failure) return;
      outputBytes += chunk.length;
      const newline = chunk.lastIndexOf(10); trailingBytes = newline < 0 ? trailingBytes + chunk.length : chunk.length - newline - 1;
      if (outputBytes > 512 * 1024) { stop('MCP output exceeded its bound.'); return; }
      try { reader.append(chunk); for (;;) { const message = reader.readMessage(); if (!message) break; receive(message); } }
      catch { stop('MCP protocol or evidence check failed.'); }
    });
    child.stdout.on('error', () => stop('MCP response pipe failed.'));
    child.stderr.on('data', chunk => { diagnosticBytes += chunk.length; diagnostics.update(chunk); if (diagnosticBytes > 16384) stop('MCP diagnostics exceeded their bound.'); });
    child.stderr.on('error', () => stop('MCP diagnostic pipe failed.'));
    child.once('close', finish);
    child.once('exit', (code, signal) => {
      clearTimeout(timer); clearTimeout(terminalTimer);
      drainTimer = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); finish(code, signal); }, 250);
    });
  });
}
