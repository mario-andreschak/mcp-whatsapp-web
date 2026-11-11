import { afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Tests must never open a real sign-in. Point every per-user data location at a throwaway
// folder before any test file loads, so the standard sign-in folder resolves in there.
const root = mkdtempSync(path.join(os.tmpdir(), 'wa-test-userdata-'));
process.env.LOCALAPPDATA = path.join(root, 'local');
process.env.XDG_DATA_HOME = path.join(root, 'share');
if (process.platform !== 'win32') process.env.HOME = root;
delete process.env.BAILEYS_SESSION_DIR;
delete process.env.WHATSAPP_SESSION_DIR;

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});
