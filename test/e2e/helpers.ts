import { spawn, execSync, ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export interface ServerHandle {
  proc: ChildProcessWithoutNullStreams;
  responses: Array<Record<string, unknown>>;
  stderr: () => string;
  nonJsonStdout: () => string[];
  send: (message: Record<string, unknown>) => void;
  rpc: (id: number, method: string, params?: Record<string, unknown>, timeoutMs?: number) => Promise<Record<string, unknown>>;
  stop: () => void;
}

export function spawnServer(args: string[] = [], env: Record<string, string> = {}): ServerHandle {
  const proc = spawn('node', ['dist/index.js', ...args], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const responses: Array<Record<string, unknown>> = [];
  const nonJson: string[] = [];
  let stderrBuf = '';
  let stdoutBuf = '';

  proc.stdout.on('data', (chunk) => {
    stdoutBuf += chunk.toString();
    let newline;
    while ((newline = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, newline).trim();
      stdoutBuf = stdoutBuf.slice(newline + 1);
      if (!line) continue;
      try {
        responses.push(JSON.parse(line));
      } catch {
        nonJson.push(line);
      }
    }
  });
  proc.stderr.on('data', (chunk) => (stderrBuf += chunk.toString()));

  const send = (message: Record<string, unknown>) => proc.stdin.write(JSON.stringify(message) + '\n');

  const rpc = async (
    id: number,
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 60_000,
  ): Promise<Record<string, unknown>> => {
    send({ jsonrpc: '2.0', id, method, params });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const response = responses.find((r) => r.id === id);
      if (response) return response;
      await sleep(200);
    }
    throw new Error(`No response for ${method} (id ${id}) within ${timeoutMs}ms. stderr:\n${stderrBuf.slice(-800)}`);
  };

  return {
    proc,
    responses,
    stderr: () => stderrBuf,
    nonJsonStdout: () => nonJson,
    send,
    rpc,
    stop: () => proc.kill(),
  };
}

export async function initializeMcp(server: ServerHandle): Promise<void> {
  await server.rpc(1, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'e2e', version: '0' },
  });
  server.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Kill headless browsers whose command line points at THIS repo's session
 * directory. Deliberately narrow so it can never touch browsers owned by
 * other installs (e.g. a live FLUJO copy of this server).
 */
export function killOwnTestBrowsers(): void {
  const marker = PROJECT_ROOT.replace(/\\/g, '.').replace(/\//g, '.');
  try {
    execSync(
      `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='msedge.exe' OR Name='chrome.exe'\\" | Where-Object { $_.CommandLine -match 'headless' -and $_.CommandLine -match '${marker}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"`,
      { stdio: 'ignore' },
    );
  } catch {
    // best-effort cleanup
  }
}
