import { randomUUID, timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isRecord } from './util';

export const SERVER_NAME = 'jupyter-vscode-mcp';
export const LOOPBACK = '127.0.0.1';
export const CONTROL_HEADER = 'x-jmcp-control-token';
export const HANDOVER_PATH = '/_internal/handover';

export type OwnershipMode = 'handover' | 'hub' | 'fail';

export interface ControlRecord {
  pid: number;
  instanceId: string;
  port: number;
  token: string;
  workspaceFolders: readonly string[];
  startedAt: number;
}

const TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const HANDOVER_TIMEOUT_MS = 1500;

function controlFile(port: number): string {
  return path.join(homedir(), '.jupyter-vscode-mcp', `control-${port}.json`);
}

export async function writeControlFile(record: ControlRecord): Promise<void> {
  const file = controlFile(record.port);
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await fs.chmod(dir, 0o700);

  const temp = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temp, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(JSON.stringify(record));
      if (process.platform !== 'win32') await handle.chmod(0o600);
    } finally {
      await handle.close();
    }
    await fs.rename(temp, file);
  } catch (error) {
    await fs.unlink(temp).catch(() => undefined);
    throw error;
  }
}

// The listener must still own the port when removing its record. Only the
// process that binds the port may publish a new record for it.
export async function removeControlFile(port: number): Promise<void> {
  await fs.rm(controlFile(port), { force: true });
}

export function matchesControlToken(header: string | string[] | undefined, token: string): boolean {
  return typeof header === 'string' && TOKEN_PATTERN.test(header)
    && timingSafeEqual(Buffer.from(header, 'hex'), Buffer.from(token, 'hex'));
}

export function isAddressInUse(error: unknown): boolean {
  return isRecord(error) && error['code'] === 'EADDRINUSE';
}

export class PortOwnershipError extends Error {
  constructor(port: number, reason: string) {
    super(`MCP port ${port} is already in use. ${reason} Change jupyter-vscode-mcp.mcpPort in Settings to use a different port.`);
  }
}

async function requestHandover(port: number, signal: AbortSignal): Promise<'retry' | 'unrelated'> {
  const base = `http://${LOOPBACK}:${port}`;
  const options = { signal, redirect: 'error' as const, headers: { Connection: 'close' } };
  const response = await fetch(`${base}/health`, options);
  if (!response.ok) {
    await response.body?.cancel();
    return response.status === 503 ? 'retry' : 'unrelated';
  }
  const health: unknown = await response.json().catch(() => undefined);
  if (!isRecord(health) || health['server'] !== SERVER_NAME) return 'unrelated';

  const record: unknown = JSON.parse(await fs.readFile(controlFile(port), 'utf8'));
  if (!isRecord(record) || record['port'] !== port || typeof record['instanceId'] !== 'string'
    || health['instanceId'] !== record['instanceId'] || typeof record['token'] !== 'string'
    || !TOKEN_PATTERN.test(record['token'])) return 'retry';

  const handover = await fetch(`${base}${HANDOVER_PATH}`, {
    ...options,
    method: 'POST',
    headers: { ...options.headers, [CONTROL_HEADER]: record['token'] },
  });
  await handover.body?.cancel();
  return 'retry';
}

export async function takeOverPort(port: number, bind: () => Promise<void>): Promise<void> {
  const deadline = Date.now() + HANDOVER_TIMEOUT_MS;
  for (let backoff = 20; ; backoff = Math.min(backoff * 2, 150)) {
    // A peer can be starting up, releasing the socket, or replacing its
    // control record while we probe it. Retry the actual bind in each case.
    const remainingMs = deadline - Date.now();
    const outcome = remainingMs > 0
      ? await requestHandover(port, AbortSignal.timeout(Math.min(300, remainingMs))).catch(() => 'retry' as const)
      : 'retry';
    try {
      await bind();
      return;
    } catch (error) {
      if (!isAddressInUse(error)) throw error;
    }
    if (outcome === 'unrelated') {
      throw new PortOwnershipError(port, 'Another process is using the port and does not support Jupyter MCP handover.');
    }
    const delayMs = Math.min(backoff, deadline - Date.now());
    if (delayMs <= 0) break;
    await delay(delayMs);
  }
  throw new PortOwnershipError(port, 'No compatible Jupyter MCP window released the port.');
}
