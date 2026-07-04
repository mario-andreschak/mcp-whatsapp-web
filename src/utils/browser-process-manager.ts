import fs from 'fs';
import path from 'path';
import { log } from './logger.js';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

// windowsHide stops tasklist/taskkill/powershell from flashing a visible
// console window when the server runs under a GUI parent (FLUJO, Claude, ...).
const EXEC_OPTS = { windowsHide: true } as const;

function parsePids(stdout: string): number[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => parseInt(line.trim(), 10))
    .filter((pid) => Number.isFinite(pid) && pid > 0);
}

/**
 * Interface representing a browser process entry
 */
interface BrowserProcess {
  pid: number;
  startTime: number;
  serverInstanceId: string; // Unique ID for this server instance
  serverPid?: number; // PID of the node process that owns this browser
}

/**
 * Manages Chrome browser processes to prevent orphaned processes
 */
export class BrowserProcessManager {
  private pidFilePath: string;
  private serverInstanceId: string;

  /**
   * Creates a new BrowserProcessManager
   * @param pidFilePath Override the PID-file location (used by tests)
   */
  constructor(pidFilePath?: string) {
    this.pidFilePath = pidFilePath ?? path.join(process.cwd(), '.chrome-pids.json');
    // Generate a unique ID for this server instance
    this.serverInstanceId = Date.now().toString() + '-' + Math.random().toString(36).substring(2, 15);
    
    log.info(`Initialized BrowserProcessManager with instance ID: ${this.serverInstanceId}`);
  }

  /**
   * Read stored browser processes from file
   * @returns Array of browser processes
   */
  readProcesses(): BrowserProcess[] {
    try {
      if (fs.existsSync(this.pidFilePath)) {
        const data = fs.readFileSync(this.pidFilePath, 'utf8');
        return JSON.parse(data) as BrowserProcess[];
      }
    } catch (error) {
      log.error('Error reading browser processes file:', error);
    }
    return [];
  }

  /**
   * Save browser processes to file
   * @param processes Array of browser processes to save
   */
  saveProcesses(processes: BrowserProcess[]): void {
    try {
      fs.writeFileSync(this.pidFilePath, JSON.stringify(processes, null, 2));
    } catch (error) {
      log.error('Error saving browser processes file:', error);
    }
  }

  /**
   * Register a new browser process
   * @param pid Process ID of the browser
   */
  registerProcess(pid: number): void {
    if (!pid) {
      log.warn('Attempted to register invalid PID');
      return;
    }

    log.info(`Registering browser process with PID: ${pid}`);
    const processes = this.readProcesses();
    
    // Check if this PID is already registered
    const entry: BrowserProcess = {
      pid,
      startTime: Date.now(),
      serverInstanceId: this.serverInstanceId,
      serverPid: process.pid,
    };
    const existingIndex = processes.findIndex(p => p.pid === pid);
    if (existingIndex >= 0) {
      processes[existingIndex] = entry;
    } else {
      processes.push(entry);
    }
    
    this.saveProcesses(processes);
  }

  /**
   * Unregister a browser process
   * @param pid Process ID of the browser to unregister
   */
  unregisterProcess(pid: number): void {
    if (!pid) {
      log.warn('Attempted to unregister invalid PID');
      return;
    }

    log.info(`Unregistering browser process with PID: ${pid}`);
    const processes = this.readProcesses();
    const filteredProcesses = processes.filter(p => p.pid !== pid);
    
    if (processes.length !== filteredProcesses.length) {
      this.saveProcesses(filteredProcesses);
    }
  }

  /**
   * Check if a process is still running
   * @param pid Process ID to check
   * @returns True if the process is running, false otherwise
   */
  async isProcessRunning(pid: number): Promise<boolean> {
    try {
      if (process.platform === 'win32') {
        // Windows
        const { stdout } = await execAsync(`tasklist /FI "PID eq ${pid}" /NH`, EXEC_OPTS);
        return stdout.includes(pid.toString());
      } else {
        // Unix-like (Linux, macOS)
        await execAsync(`ps -p ${pid} -o pid=`, EXEC_OPTS);
        return true;
      }
    } catch {
      // Process not found
      return false;
    }
  }

  /**
   * Kill a process by its PID
   * @param pid Process ID to kill
   * @returns True if the process was killed successfully, false otherwise
   */
  async killProcess(pid: number): Promise<boolean> {
    try {
      log.info(`Attempting to kill browser process with PID: ${pid}`);
      
      if (process.platform === 'win32') {
        // Windows
        await execAsync(`taskkill /F /PID ${pid}`, EXEC_OPTS);
      } else {
        // Unix-like (Linux, macOS)
        await execAsync(`kill -9 ${pid}`, EXEC_OPTS);
      }
      return true;
    } catch (error) {
      log.error(`Failed to kill process ${pid}:`, error);
      return false;
    }
  }

  /**
   * Force-kill a process and all of its children. Used as the last resort when
   * a graceful client.destroy() hangs or times out: a browser left half-alive
   * keeps the WhatsApp session directory locked for every future instance.
   */
  async killProcessTree(pid: number): Promise<boolean> {
    try {
      log.info(`Force-killing browser process tree with root PID: ${pid}`);
      if (process.platform === 'win32') {
        await execAsync(`taskkill /F /T /PID ${pid}`, EXEC_OPTS);
      } else {
        await execAsync(`kill -9 ${pid}`, EXEC_OPTS);
      }
      return true;
    } catch (error) {
      log.warn(`Failed to kill process tree ${pid}:`, error);
      return false;
    }
  }

  /**
   * Find browser processes whose command line references the given profile
   * (user-data-dir) path. Unlike the PID file, this catches browsers that were
   * never registered (e.g. the server was force-killed mid-initialize) - the
   * exact processes that keep the session directory locked.
   */
  async findBrowsersUsingProfile(userDataDir: string): Promise<number[]> {
    try {
      if (process.platform === 'win32') {
        // The profile path travels via an env var and is compared with
        // String.Contains (no regex, no quoting) so paths with spaces,
        // parentheses, quotes, etc. cannot break the query. -EncodedCommand
        // sidesteps every layer of argv/PowerShell quoting.
        const script =
          '$dir = $env:WA_MCP_PROFILE_DIR; ' +
          'Get-CimInstance Win32_Process -Filter "Name=\'chrome.exe\' OR Name=\'msedge.exe\' OR Name=\'chromium.exe\' OR Name=\'headless_shell.exe\'" | ' +
          'Where-Object { $_.CommandLine -and $_.CommandLine.Contains($dir) } | ' +
          'ForEach-Object { $_.ProcessId }';
        const encoded = Buffer.from(script, 'utf16le').toString('base64');
        const { stdout } = await execFileAsync(
          'powershell',
          ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
          { ...EXEC_OPTS, env: { ...process.env, WA_MCP_PROFILE_DIR: userDataDir } },
        );
        return parsePids(stdout);
      } else {
        // pgrep -f matches against the full command line; escape the path so
        // it is treated as a literal string, not a regex.
        const pattern = userDataDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const { stdout } = await execFileAsync('pgrep', ['-f', pattern], EXEC_OPTS);
        return parsePids(stdout);
      }
    } catch {
      // pgrep exits non-zero when nothing matches; treat all failures as "none found"
      return [];
    }
  }

  /**
   * Kill browser processes that hold the given profile directory, except those
   * legitimately owned by a still-running server instance. This is the
   * self-healing path for "The browser is already running for <session dir>"
   * launch failures caused by force-killed or zombie predecessors.
   *
   * @param opts.includeOwnedByCurrentProcess Also kill browsers registered to
   *        THIS process (used when tearing down our own hung browser).
   * @returns Number of processes killed.
   */
  async killBrowsersUsingProfile(
    userDataDir: string,
    opts: { includeOwnedByCurrentProcess?: boolean } = {},
  ): Promise<number> {
    const pids = await this.findBrowsersUsingProfile(userDataDir);
    if (pids.length === 0) {
      return 0;
    }
    const registered = this.readProcesses();
    let killedCount = 0;
    for (const pid of pids) {
      const entry = registered.find((p) => p.pid === pid);
      if (entry?.serverPid !== undefined) {
        const ownedByUs = entry.serverPid === process.pid;
        const ownerAlive = ownedByUs || (await this.isProcessRunning(entry.serverPid));
        // Never touch a browser whose owning server is alive - it legitimately
        // holds the session (unless it is ours and the caller asked for it).
        if (ownerAlive && !(ownedByUs && opts.includeOwnedByCurrentProcess)) {
          continue;
        }
      }
      if (await this.killProcessTree(pid)) {
        killedCount++;
        this.unregisterProcess(pid);
      }
    }
    if (killedCount > 0) {
      log.info(`Killed ${killedCount} browser process(es) holding the profile at ${userDataDir}.`);
    }
    return killedCount;
  }

  /**
   * Clean up orphaned browser processes
   */
  async cleanupOrphanedProcesses(): Promise<void> {
    log.info('Cleaning up orphaned browser processes...');
    const processes = this.readProcesses();
    const validProcesses: BrowserProcess[] = [];
    
    for (const entry of processes) {
      const isRunning = await this.isProcessRunning(entry.pid);
      if (!isRunning) {
        // Browser is gone; just drop the stale entry
        continue;
      }

      const isFromCurrentInstance = entry.serverInstanceId === this.serverInstanceId;
      if (isFromCurrentInstance) {
        validProcesses.push(entry);
        continue;
      }

      // A browser is orphaned exactly when the node process that owned it is
      // dead (e.g. an MCP client force-killed the server, leaving the browser
      // holding the session-directory lock). If the owning server is still
      // alive, the browser is legitimately in use - never kill it.
      if (entry.serverPid !== undefined) {
        const ownerAlive = entry.serverPid === process.pid || (await this.isProcessRunning(entry.serverPid));
        if (ownerAlive) {
          validProcesses.push(entry);
        } else {
          log.info(`Browser PID ${entry.pid} is orphaned (owning server ${entry.serverPid} is dead), killing it.`);
          const killed = await this.killProcess(entry.pid);
          if (!killed) {
            validProcesses.push(entry);
          }
        }
        continue;
      }

      // Legacy entry without serverPid: fall back to the old age heuristic
      const isOld = Date.now() - entry.startTime > 10 * 60 * 1000; // 10 minutes
      if (isOld) {
        log.info(`Found orphaned browser process with PID: ${entry.pid} (legacy entry)`);
        const killed = await this.killProcess(entry.pid);
        if (!killed) {
          validProcesses.push(entry);
        }
      } else {
        validProcesses.push(entry);
      }
    }
    
    // Save the updated list
    this.saveProcesses(validProcesses);
    log.info(`Cleanup complete. ${processes.length - validProcesses.length} orphaned processes removed.`);
  }
}
