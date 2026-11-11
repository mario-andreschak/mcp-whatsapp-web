import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Folder name used under the per-user data location. */
export const APP_FOLDER = 'mcp-whatsapp-web';

export interface PlatformInfo {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
}

/**
 * A fixed per-user place for sign-ins, independent of the folder a program starts the server from:
 * Windows %LOCALAPPDATA%\mcp-whatsapp-web, macOS ~/Library/Application Support/mcp-whatsapp-web,
 * Linux and others $XDG_DATA_HOME/mcp-whatsapp-web (normally ~/.local/share/mcp-whatsapp-web).
 */
export function userDataRoot({ env = process.env, platform = process.platform, home = os.homedir() }: PlatformInfo = {}): string {
  if (platform === 'win32') return path.join(env.LOCALAPPDATA?.trim() || path.join(home, 'AppData', 'Local'), APP_FOLDER);
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', APP_FOLDER);
  const xdg = env.XDG_DATA_HOME?.trim();
  return path.join(xdg && path.isAbsolute(xdg) ? xdg : path.join(home, '.local', 'share'), APP_FOLDER);
}

export type FolderSource = 'configured' | 'previous' | 'standard';

export interface FolderChoice {
  /** Absolute folder to use. */
  dir: string;
  /** Why this folder was chosen. */
  source: FolderSource;
  /** One plain sentence for the start-up log. */
  explanation: string;
}

export interface FolderOptions extends PlatformInfo {
  /** An explicitly configured folder (a setting or a constructor option); always wins when not blank. */
  configured?: string;
  /** Name of the setting people use to choose the folder, for the log text. */
  settingName: string;
  /** Folder name, used both in the old working-directory place and under the per-user place. */
  folderName: string;
  /** Tells whether a folder already holds a sign-in. */
  holdsSignIn: (dir: string) => boolean;
  cwd?: string;
}

/**
 * Picks the sign-in folder. An explicit setting always wins. Without one, a sign-in that already
 * lives in the old place (inside the folder the server was started from) keeps being used, so
 * existing setups do not lose their link. Everything else uses the fixed per-user place.
 */
export function chooseSignInFolder(options: FolderOptions): FolderChoice {
  const configured = options.configured?.trim();
  if (configured) {
    const dir = path.resolve(configured);
    return { dir, source: 'configured', explanation: `Using the sign-in folder set in ${options.settingName}: ${dir}` };
  }
  const standard = path.join(userDataRoot(options), options.folderName);
  const previous = path.resolve(options.cwd ?? process.cwd(), options.folderName);
  if (previous !== standard && safeHoldsSignIn(options.holdsSignIn, previous)) {
    return {
      dir: previous,
      source: 'previous',
      explanation: `Found an existing sign-in in the old place (${previous}), so this server keeps using it. `
        + `To use the standard place instead, stop the server and move that folder to ${standard}, or set ${options.settingName}.`,
    };
  }
  return { dir: standard, source: 'standard', explanation: `Using the standard sign-in folder: ${standard}` };
}

function safeHoldsSignIn(check: (dir: string) => boolean, dir: string): boolean {
  try { return check(dir); } catch { return false; }
}

/** A Baileys sign-in is a non-empty session database. */
export function baileysFolderHoldsSignIn(dir: string): boolean {
  try { return fs.statSync(path.join(dir, 'session.sqlite')).size > 0; } catch { return false; }
}

/** whatsapp-web.js (LocalAuth without a client id) keeps its browser profile in a "session" subfolder. */
export function webjsFolderHoldsSignIn(dir: string): boolean {
  try { return fs.readdirSync(path.join(dir, 'session')).length > 0; } catch { return false; }
}

/**
 * The web.js OAuth store used to live in the working directory. Keep using an existing one there;
 * otherwise keep it beside the sign-in it belongs to.
 */
export function webjsOAuthStorePath(sessionDir: string, cwd = process.cwd()): string {
  const previous = path.join(cwd, '.oauth-store.json');
  return fs.existsSync(previous) ? previous : path.join(sessionDir, 'oauth-store.json');
}
