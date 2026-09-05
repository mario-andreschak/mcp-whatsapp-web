import type { WhatsAppBackend } from './backend.js';

export function configuredBackend(): WhatsAppBackend['backend'] {
  const value = process.env.WHATSAPP_BACKEND?.trim().toLowerCase() || 'webjs';
  if (value !== 'webjs' && value !== 'baileys') {
    throw new Error(`Unknown WHATSAPP_BACKEND '${value}'. Choose webjs or baileys.`);
  }
  return value;
}

/** Load only the selected driver; Baileys never imports or starts Puppeteer. */
export async function createWhatsAppBackend(): Promise<WhatsAppBackend> {
  if (configuredBackend() === 'webjs') {
    const { WhatsAppService } = await import('./whatsapp.js');
    return new WhatsAppService();
  }

  let module: typeof import('./baileys.js');
  try {
    module = await import('./baileys.js');
  } catch (error) {
    throw new Error(
      'Could not load the Baileys backend. Install optional dependencies with npm install --include=optional ' +
      'and use a supported Node.js version. ' + (error instanceof Error ? error.message : String(error)),
      { cause: error },
    );
  }
  return new module.BaileysService();
}
