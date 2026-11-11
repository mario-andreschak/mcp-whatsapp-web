import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  baileysFolderHoldsSignIn, chooseSignInFolder, userDataRoot, webjsFolderHoldsSignIn, webjsOAuthStorePath,
} from '../src/utils/data-paths.js';
import { packageVersion } from '../src/utils/version.js';

const logged = vi.hoisted(() => ({ info: [] as string[], warn: [] as string[] }));
vi.mock('../src/utils/logger.js', () => ({
  log: {
    info: (message: string) => logged.info.push(message), warn: (message: string) => logged.warn.push(message),
    debug: () => {}, error: () => {},
  },
}));

const directories: string[] = [];
function temp(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'wa-data-paths-'));
  directories.push(directory);
  return directory;
}

function withBaileysSignIn(directory: string): string {
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, 'session.sqlite'), 'not empty');
  return directory;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  logged.info.length = 0;
  logged.warn.length = 0;
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('per-user data location', () => {
  it('is fixed per user on every platform and independent of the working directory', () => {
    const home = path.join(path.sep, 'home', 'someone');
    expect(userDataRoot({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\someone\\AppData\\Local' }, home }))
      .toBe(path.join('C:\\Users\\someone\\AppData\\Local', 'mcp-whatsapp-web'));
    expect(userDataRoot({ platform: 'win32', env: {}, home })).toBe(path.join(home, 'AppData', 'Local', 'mcp-whatsapp-web'));
    expect(userDataRoot({ platform: 'darwin', env: {}, home })).toBe(path.join(home, 'Library', 'Application Support', 'mcp-whatsapp-web'));
    expect(userDataRoot({ platform: 'linux', env: {}, home })).toBe(path.join(home, '.local', 'share', 'mcp-whatsapp-web'));
    const xdg = path.join(path.sep, 'data');
    expect(userDataRoot({ platform: 'linux', env: { XDG_DATA_HOME: xdg }, home })).toBe(path.join(xdg, 'mcp-whatsapp-web'));
    // A relative XDG_DATA_HOME is invalid by the specification and ignored.
    expect(userDataRoot({ platform: 'linux', env: { XDG_DATA_HOME: 'relative' }, home })).toBe(path.join(home, '.local', 'share', 'mcp-whatsapp-web'));
  });

  it('is redirected away from the real user folders while tests run', () => {
    expect(userDataRoot()).not.toBe(path.join(os.homedir(), 'AppData', 'Local', 'mcp-whatsapp-web'));
    expect(userDataRoot().startsWith(os.tmpdir())).toBe(true);
  });
});

describe('choosing the sign-in folder', () => {
  const base = { settingName: 'BAILEYS_SESSION_DIR', folderName: 'baileys-sessions', holdsSignIn: baileysFolderHoldsSignIn };

  it('always uses an explicitly configured folder, even when an old sign-in exists', () => {
    const cwd = temp();
    withBaileysSignIn(path.join(cwd, 'baileys-sessions'));
    const configured = path.join(temp(), 'mine');
    const choice = chooseSignInFolder({ ...base, cwd, configured });
    expect(choice).toMatchObject({ dir: configured, source: 'configured' });
    expect(choice.explanation).toContain('BAILEYS_SESSION_DIR');
  });

  it('resolves a relative configured folder and ignores a blank setting', () => {
    const cwd = temp();
    expect(chooseSignInFolder({ ...base, cwd, configured: 'relative-dir' }).dir).toBe(path.resolve('relative-dir'));
    expect(chooseSignInFolder({ ...base, cwd, configured: '   ' }).source).toBe('standard');
  });

  it('keeps using a sign-in that already lives in the old working-directory place, and says so', () => {
    const cwd = temp();
    const previous = withBaileysSignIn(path.join(cwd, 'baileys-sessions'));
    const choice = chooseSignInFolder({ ...base, cwd });
    expect(choice).toMatchObject({ dir: previous, source: 'previous' });
    expect(choice.explanation).toContain('old place');
    expect(choice.explanation).toContain(path.join(userDataRoot(), 'baileys-sessions'));
  });

  it('uses the standard place when there is no setting and no old sign-in', () => {
    const cwd = temp();
    mkdirSync(path.join(cwd, 'baileys-sessions'));
    writeFileSync(path.join(cwd, 'baileys-sessions', 'session.sqlite'), ''); // empty: not a sign-in
    const choice = chooseSignInFolder({ ...base, cwd });
    expect(choice).toMatchObject({ dir: path.join(userDataRoot(), 'baileys-sessions'), source: 'standard' });
  });

  it('treats a folder check that fails as "no sign-in"', () => {
    const choice = chooseSignInFolder({ ...base, cwd: temp(), holdsSignIn: () => { throw new Error('no access'); } });
    expect(choice.source).toBe('standard');
  });

  it('recognises a web.js sign-in by its saved browser profile', () => {
    const cwd = temp();
    expect(webjsFolderHoldsSignIn(path.join(cwd, 'whatsapp-sessions'))).toBe(false);
    mkdirSync(path.join(cwd, 'whatsapp-sessions', 'session'), { recursive: true });
    expect(webjsFolderHoldsSignIn(path.join(cwd, 'whatsapp-sessions'))).toBe(false);
    writeFileSync(path.join(cwd, 'whatsapp-sessions', 'session', 'Local State'), '{}');
    expect(webjsFolderHoldsSignIn(path.join(cwd, 'whatsapp-sessions'))).toBe(true);
    const choice = chooseSignInFolder({
      settingName: 'WHATSAPP_SESSION_DIR', folderName: 'whatsapp-sessions', holdsSignIn: webjsFolderHoldsSignIn, cwd,
    });
    expect(choice).toMatchObject({ dir: path.join(cwd, 'whatsapp-sessions'), source: 'previous' });
  });
});

describe('the Baileys backend folder', () => {
  it('starts in the standard place regardless of the working directory and logs where it is', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(temp());
    const { BaileysService } = await import('../src/services/baileys.js');
    const service = new BaileysService();
    expect(service.sessionDir).toBe(path.join(userDataRoot(), 'baileys-sessions'));
    expect(logged.info.some(line => line.includes('standard sign-in folder'))).toBe(true);
  });

  it('keeps an old working-directory sign-in when no folder is configured', async () => {
    const cwd = temp();
    vi.spyOn(process, 'cwd').mockReturnValue(cwd);
    withBaileysSignIn(path.join(cwd, 'baileys-sessions'));
    const { BaileysService } = await import('../src/services/baileys.js');
    expect(new BaileysService().sessionDir).toBe(path.join(cwd, 'baileys-sessions'));
    expect(logged.info.some(line => line.includes('Found an existing sign-in in the old place'))).toBe(true);
  });

  it('honours BAILEYS_SESSION_DIR over everything else', async () => {
    const cwd = temp();
    vi.spyOn(process, 'cwd').mockReturnValue(cwd);
    withBaileysSignIn(path.join(cwd, 'baileys-sessions'));
    const configured = path.join(temp(), 'configured');
    vi.stubEnv('BAILEYS_SESSION_DIR', configured);
    const { BaileysService } = await import('../src/services/baileys.js');
    expect(new BaileysService().sessionDir).toBe(configured);
  });
});

describe('OAuth store location', () => {
  it('keeps Baileys tokens beside the Baileys sign-in', async () => {
    const { oauthStorePath } = await import('../src/server.js');
    const dir = temp();
    expect(oauthStorePath({ backend: 'baileys', sessionDir: dir })).toBe(path.join(dir, 'oauth-store.json'));
  });

  it('keeps an existing web.js store in the working directory, otherwise uses the web.js sign-in folder', () => {
    const cwd = temp();
    const sessionDir = path.join(temp(), 'whatsapp-sessions');
    expect(webjsOAuthStorePath(sessionDir, cwd)).toBe(path.join(sessionDir, 'oauth-store.json'));
    writeFileSync(path.join(cwd, '.oauth-store.json'), '{}');
    expect(webjsOAuthStorePath(sessionDir, cwd)).toBe(path.join(cwd, '.oauth-store.json'));
  });
});

describe('version', () => {
  it('reports the version recorded in package.json', () => {
    const recorded = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
    expect(packageVersion()).toBe(recorded);
    expect(readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')).not.toMatch(/Server v\d/);
  });
});
