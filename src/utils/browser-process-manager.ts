import fs from 'fs';
import path from 'path';
import { log } from './logger.js';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

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
   */
  constructor() {
    this.pidFilePath = path.join(process.cwd(), '.chrome-pids.json');
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
        const { stdout } = await execAsync(`tasklist /FI "PID eq ${pid}" /NH`);
        return stdout.includes(pid.toString());
      } else {
        // Unix-like (Linux, macOS)
        await execAsync(`ps -p ${pid} -o pid=`);
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
        await execAsync(`taskkill /F /PID ${pid}`);
      } else {
        // Unix-like (Linux, macOS)
        await execAsync(`kill -9 ${pid}`);
      }
      return true;
    } catch (error) {
      log.error(`Failed to kill process ${pid}:`, error);
      return false;
    }
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
