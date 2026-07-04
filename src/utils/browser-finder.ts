import fs from 'fs';
import path from 'path';
import { log } from './logger.js';

/**
 * Well-known install locations of Chromium-based browsers with proprietary
 * codec support (H.264/AAC), per platform. Chrome is preferred over Edge
 * only by list order; both work equally well for whatsapp-web.js.
 */
function getCandidatePaths(): string[] {
  switch (process.platform) {
    case 'win32': {
      const programFiles = process.env['PROGRAMFILES'] || 'C:\\Program Files';
      const programFilesX86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
      const localAppData = process.env['LOCALAPPDATA'] || '';
      return [
        path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        ...(localAppData ? [path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe')] : []),
        path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      ];
    }
    case 'darwin':
      return [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      ];
    default:
      // Linux and friends
      return [
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/microsoft-edge',
        '/usr/bin/microsoft-edge-stable',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/snap/bin/chromium',
      ];
  }
}

/**
 * Resolve the browser executable to use for whatsapp-web.js.
 *
 * Resolution order:
 * 1. BROWSER_EXECUTABLE_PATH env var (or legacy CHROME_EXECUTABLE_PATH)
 * 2. Auto-detected Chrome or Edge in standard install locations
 * 3. undefined - puppeteer falls back to its bundled Chromium
 *    (video/GIF sending will not work: bundled Chromium lacks H.264/AAC)
 *
 * @returns Absolute path to a browser executable, or undefined if none found.
 */
export function findBrowserExecutable(): string | undefined {
  const configured = process.env.BROWSER_EXECUTABLE_PATH || process.env.CHROME_EXECUTABLE_PATH;
  if (configured) {
    if (fs.existsSync(configured)) {
      log.info(`Using configured browser executable: ${configured}`);
      return configured;
    }
    log.warn(
      `Configured browser executable does not exist: ${configured}. Falling back to auto-detection.`,
    );
  }

  for (const candidate of getCandidatePaths()) {
    if (fs.existsSync(candidate)) {
      log.info(`Auto-detected browser executable: ${candidate}`);
      return candidate;
    }
  }

  log.warn(
    'No Chrome or Edge installation found. Falling back to the Chromium bundled with puppeteer. ' +
      'Sending videos/GIFs will not work (missing H.264/AAC codecs). ' +
      'Install Chrome or Edge, or set BROWSER_EXECUTABLE_PATH.',
  );
  return undefined;
}
