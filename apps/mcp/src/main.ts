import { resolve } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { DaemonClient } from './daemon-client.js';
import { createMcpServer } from './server.js';

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 0 && (args.length !== 2 || args[0] !== '--project' || !args[1])) {
    throw new Error('Use arcane MCP [--project PROJECT_DIRECTORY].');
  }
  const client = DaemonClient.fromEnvironment();
  const server = createMcpServer({ client, projectRoot: resolve(args[1] ?? process.cwd()) });
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await server.close();
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void close().then(() => process.exit(0)); });
  process.stdin.once('end', () => { void close(); });
  await server.connect(new StdioServerTransport());
}

main().catch(error => {
  // stdout belongs exclusively to the official SDK JSON-RPC transport.
  const code = error instanceof Error && 'code' in error ? String(error.code) : 'STARTUP';
  process.stderr.write(`Arcane MCP ${code}: check ARCANE_DAEMON_URL, ARCANE_LOCAL_TOKEN and project arguments.\n`);
  process.exitCode = 1;
});
