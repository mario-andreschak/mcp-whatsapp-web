import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { findBrowserExecutable } from '../src/utils/browser-finder.js';

const ENV_KEYS = ['BROWSER_EXECUTABLE_PATH', 'CHROME_EXECUTABLE_PATH'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

// process.execPath (the node binary) is a file guaranteed to exist on any machine
const EXISTING_FILE = process.execPath;

describe('findBrowserExecutable', () => {
  it('honors BROWSER_EXECUTABLE_PATH when the file exists', () => {
    process.env.BROWSER_EXECUTABLE_PATH = EXISTING_FILE;
    expect(findBrowserExecutable()).toBe(EXISTING_FILE);
  });

  it('honors the legacy CHROME_EXECUTABLE_PATH alias', () => {
    process.env.CHROME_EXECUTABLE_PATH = EXISTING_FILE;
    expect(findBrowserExecutable()).toBe(EXISTING_FILE);
  });

  it('prefers the new variable over the legacy one', () => {
    process.env.BROWSER_EXECUTABLE_PATH = EXISTING_FILE;
    process.env.CHROME_EXECUTABLE_PATH = 'C:\\does\\not\\exist\\browser.exe';
    expect(findBrowserExecutable()).toBe(EXISTING_FILE);
  });

  it('falls back to auto-detection when the configured path does not exist', () => {
    process.env.BROWSER_EXECUTABLE_PATH = 'C:\\does\\not\\exist\\browser.exe';
    const result = findBrowserExecutable();
    expect(result).not.toBe('C:\\does\\not\\exist\\browser.exe');
    // Auto-detection is machine-dependent: either a real browser path or undefined
    if (result !== undefined) {
      expect(typeof result).toBe('string');
    }
  });

  it('auto-detects without env vars and never throws', () => {
    const result = findBrowserExecutable();
    if (result !== undefined) {
      expect(result).toMatch(/chrome|edge|chromium/i);
    }
  });
});
