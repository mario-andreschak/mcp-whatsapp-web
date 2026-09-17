import { describe, it } from 'vitest';
// Release probes create isolated temporary session directories and never connect to WhatsApp.
import { wireSmoke } from '../../scripts/wire-smoke.mjs';
describe('real compiled stdio package, offline', () => {
  for (const backend of ['webjs', 'baileys']) for (const modern of [true, false]) {
    it(backend + (modern ? ' modern' : ' legacy'), async () => { await wireSmoke('dist/index.js', backend, modern); }, 30000);
  }
});
