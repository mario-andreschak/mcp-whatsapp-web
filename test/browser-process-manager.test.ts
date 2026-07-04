import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { BrowserProcessManager } from '../src/utils/browser-process-manager.js';

let pidFile: string;
let manager: BrowserProcessManager;

beforeEach(() => {
  pidFile = path.join(os.tmpdir(), `chrome-pids-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  manager = new BrowserProcessManager(pidFile);
});

afterEach(() => {
  if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
});

const readEntries = () => JSON.parse(fs.readFileSync(pidFile, 'utf8')) as Array<Record<string, unknown>>;

describe('registration', () => {
  it('registers a browser pid together with the owning server pid', () => {
    manager.registerProcess(4242);
    const [entry] = readEntries();
    expect(entry.pid).toBe(4242);
    expect(entry.serverPid).toBe(process.pid);
    expect(typeof entry.serverInstanceId).toBe('string');
  });

  it('updates instead of duplicating an already-registered pid', () => {
    manager.registerProcess(4242);
    manager.registerProcess(4242);
    expect(readEntries()).toHaveLength(1);
  });

  it('unregisters pids', () => {
    manager.registerProcess(4242);
    manager.unregisterProcess(4242);
    expect(readEntries()).toHaveLength(0);
  });
});

describe('orphan cleanup', () => {
  /** Simulate which pids are "running" and record kill attempts. */
  function fakeProcessTable(alive: number[]) {
    const killed: number[] = [];
    vi.spyOn(manager, 'isProcessRunning').mockImplementation(async (pid: number) => alive.includes(pid));
    vi.spyOn(manager, 'killProcess').mockImplementation(async (pid: number) => {
      killed.push(pid);
      return true;
    });
    return killed;
  }

  const writeEntries = (entries: Array<Record<string, unknown>>) =>
    fs.writeFileSync(pidFile, JSON.stringify(entries));

  it('prunes entries whose browser is no longer running, without killing', async () => {
    writeEntries([{ pid: 111, startTime: Date.now(), serverInstanceId: 'other', serverPid: 999 }]);
    const killed = fakeProcessTable([]); // nothing alive
    await manager.cleanupOrphanedProcesses();
    expect(killed).toHaveLength(0);
    expect(readEntries()).toHaveLength(0);
  });

  it('kills a browser whose owning server is dead (true orphan), immediately', async () => {
    writeEntries([{ pid: 111, startTime: Date.now(), serverInstanceId: 'other', serverPid: 999 }]);
    const killed = fakeProcessTable([111]); // browser alive, owner 999 dead
    await manager.cleanupOrphanedProcesses();
    expect(killed).toEqual([111]);
    expect(readEntries()).toHaveLength(0);
  });

  it('never kills a browser whose owning server is still alive', async () => {
    writeEntries([
      { pid: 111, startTime: Date.now() - 60 * 60 * 1000, serverInstanceId: 'other', serverPid: 999 },
    ]);
    const killed = fakeProcessTable([111, 999]); // both alive - even though the entry is 1h old
    await manager.cleanupOrphanedProcesses();
    expect(killed).toHaveLength(0);
    expect(readEntries()).toHaveLength(1);
  });

  it('keeps this instance:s own browser', async () => {
    manager.registerProcess(4242);
    const killed = fakeProcessTable([4242]);
    await manager.cleanupOrphanedProcesses();
    expect(killed).toHaveLength(0);
    expect(readEntries()).toHaveLength(1);
  });

  it('applies the legacy 10-minute rule to entries without a serverPid', async () => {
    writeEntries([
      { pid: 111, startTime: Date.now() - 11 * 60 * 1000, serverInstanceId: 'other' }, // old -> kill
      { pid: 222, startTime: Date.now() - 1 * 60 * 1000, serverInstanceId: 'other' }, // young -> keep
    ]);
    const killed = fakeProcessTable([111, 222]);
    await manager.cleanupOrphanedProcesses();
    expect(killed).toEqual([111]);
    expect(readEntries().map((e) => e.pid)).toEqual([222]);
  });

  it('keeps an entry it failed to kill so a later cleanup can retry', async () => {
    writeEntries([{ pid: 111, startTime: Date.now(), serverInstanceId: 'other', serverPid: 999 }]);
    vi.spyOn(manager, 'isProcessRunning').mockImplementation(async (pid: number) => pid === 111);
    vi.spyOn(manager, 'killProcess').mockResolvedValue(false);
    await manager.cleanupOrphanedProcesses();
    expect(readEntries()).toHaveLength(1);
  });

  it('survives a corrupt pid file', async () => {
    fs.writeFileSync(pidFile, '{{{{ not json');
    await expect(manager.cleanupOrphanedProcesses()).resolves.toBeUndefined();
    expect(readEntries()).toHaveLength(0);
  });
});
