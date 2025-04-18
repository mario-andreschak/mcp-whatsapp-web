#!/usr/bin/env node

/**
 * Utility script to detect and clean up orphaned Chrome browser processes
 * that may have been left behind by the WhatsApp MCP server.
 * 
 * Usage:
 *   npm run cleanup-browsers
 *   
 * Or directly:
 *   node dist/utils/cleanup-browsers.js
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { log } from './logger.js';
import { BrowserProcessManager } from './browser-process-manager.js';

const execAsync = promisify(exec);

/**
 * Find Chrome processes that might be related to WhatsApp Web
 */
async function findChromeBrowsers(): Promise<{ pid: number; command: string }[]> {
  try {
    let command: string;
    let processParser: (stdout: string) => { pid: number; command: string }[];

    if (process.platform === 'win32') {
      // Windows
      command = 'wmic process where "name=\'chrome.exe\'" get processid,commandline';
      processParser = (stdout: string) => {
        const lines = stdout.trim().split('\n').slice(1); // Skip header
        return lines.map(line => {
          const parts = line.trim().split(/\s+/);
          const pid = parseInt(parts[parts.length - 1], 10);
          const command = parts.slice(0, -1).join(' ');
          return { pid, command };
        }).filter(p => !isNaN(p.pid));
      };
    } else {
      // Unix-like (Linux, macOS)
      command = 'ps -eo pid,command | grep -i chrome';
      processParser = (stdout: string) => {
        return stdout.trim().split('\n')
          .filter(line => !line.includes('grep'))
          .map(line => {
            const parts = line.trim().split(/\s+/);
            const pid = parseInt(parts[0], 10);
            const command = parts.slice(1).join(' ');
            return { pid, command };
          });
      };
    }

    const { stdout } = await execAsync(command);
    return processParser(stdout);
  } catch (error) {
    log.error('Error finding Chrome processes:', error);
    return [];
  }
}

/**
 * Identify Chrome processes that are likely related to WhatsApp Web
 */
function identifyWhatsAppChromeBrowsers(processes: { pid: number; command: string }[]): { pid: number; command: string }[] {
  // Look for Chrome processes with WhatsApp-related command line arguments
  const whatsAppIndicators = [
    'whatsapp',
    'puppeteer',
    'headless',
    'user-data-dir=',
    'whatsapp-sessions'
  ];

  return processes.filter(process => {
    const command = process.command.toLowerCase();
    return whatsAppIndicators.some(indicator => command.includes(indicator));
  });
}

/**
 * Main function to clean up orphaned browser processes
 */
async function cleanupOrphanedBrowsers(): Promise<void> {
  log.info('Starting manual cleanup of orphaned Chrome browser processes...');
  
  // First, use the BrowserProcessManager to clean up known processes
  const browserManager = new BrowserProcessManager();
  await browserManager.cleanupOrphanedProcesses();
  
  // Then, look for any Chrome processes that might be related to WhatsApp
  const allChromeProcesses = await findChromeBrowsers();
  log.info(`Found ${allChromeProcesses.length} Chrome processes running`);
  
  const whatsAppChromeProcesses = identifyWhatsAppChromeBrowsers(allChromeProcesses);
  log.info(`Identified ${whatsAppChromeProcesses.length} Chrome processes that might be related to WhatsApp`);
  
  if (whatsAppChromeProcesses.length === 0) {
    log.info('No orphaned WhatsApp Chrome processes found.');
    return;
  }
  
  // Display the processes
  whatsAppChromeProcesses.forEach(process => {
    log.info(`PID ${process.pid}: ${process.command.substring(0, 100)}${process.command.length > 100 ? '...' : ''}`);
  });
  
  // Ask for confirmation before killing
  if (process.stdin.isTTY) {
    process.stdout.write('Do you want to kill these processes? (y/N): ');
    process.stdin.setEncoding('utf8');
    process.stdin.resume();
    
    const response = await new Promise<string>(resolve => {
      process.stdin.once('data', (data) => {
        resolve(data.toString().trim().toLowerCase());
      });
    });
    
    process.stdin.pause();
    
    if (response !== 'y' && response !== 'yes') {
      log.info('Operation cancelled by user.');
      return;
    }
  } else {
    // If not running in TTY, just log and continue
    log.info('Running in non-interactive mode, will attempt to kill processes');
  }
  
  // Kill the processes
  let killedCount = 0;
  for (const process of whatsAppChromeProcesses) {
    try {
      log.info(`Attempting to kill process ${process.pid}...`);
      await browserManager.killProcess(process.pid);
      killedCount++;
    } catch (error) {
      log.error(`Failed to kill process ${process.pid}:`, error);
    }
  }
  
  log.info(`Cleanup complete. ${killedCount} of ${whatsAppChromeProcesses.length} processes killed.`);
}

// Run the cleanup
cleanupOrphanedBrowsers()
  .then(() => {
    log.info('Browser cleanup completed successfully');
    process.exit(0);
  })
  .catch(error => {
    log.error('Error during browser cleanup:', error);
    process.exit(1);
  });
