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
    const existingIndex = processes.findIndex(p => p.pid === pid);
    if (existingIndex >= 0) {
      // Update the existing entry
      processes[existingIndex] = {
        pid,
        startTime: Date.now(),
        serverInstanceId: this.serverInstanceId
      };
    } else {
      // Add a new entry
      processes.push({
        pid,
        startTime: Date.now(),
        serverInstanceId: this.serverInstanceId
      });
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
    } catch (error) {
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
    
    for (const process of processes) {
      const isRunning = await this.isProcessRunning(process.pid);
      
      if (isRunning) {
        // Process is still running, check if it's orphaned
        // We consider a process orphaned if it's not from this server instance
        // and it's been running for more than 10 minutes
        const isFromCurrentInstance = process.serverInstanceId === this.serverInstanceId;
        const processAgeMs = Date.now() - process.startTime;
        const isOld = processAgeMs > 10 * 60 * 1000; // 10 minutes
        
        if (!isFromCurrentInstance && isOld) {
          log.info(`Found orphaned browser process with PID: ${process.pid}`);
          const killed = await this.killProcess(process.pid);
          if (!killed) {
            // If we couldn't kill it, keep it in the list
            validProcesses.push(process);
          }
        } else {
          // Process is still valid
          validProcesses.push(process);
        }
      }
      // If not running, we don't add it to validProcesses
    }
    
    // Save the updated list
    this.saveProcesses(validProcesses);
    log.info(`Cleanup complete. ${processes.length - validProcesses.length} orphaned processes removed.`);
  }
}
