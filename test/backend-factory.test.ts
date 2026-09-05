import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const webjsBackend = { backend: 'webjs' as const };
const baileysBackend = { backend: 'baileys' as const };
const importWebjs = vi.fn();
const importBaileys = vi.fn();
const WebjsConstructor = vi.fn(function () { return webjsBackend; });
const BaileysConstructor = vi.fn(function () { return baileysBackend; });

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.stubEnv('WHATSAPP_BACKEND', '');
  WebjsConstructor.mockImplementation(function () { return webjsBackend; });
  BaileysConstructor.mockImplementation(function () { return baileysBackend; });
  // These module factories execute only when dynamically imported. Mocking
  // the service boundary also prevents any browser, socket, or database work.
  vi.doMock('../src/services/whatsapp.js', () => {
    importWebjs();
    return { WhatsAppService: WebjsConstructor };
  });
  vi.doMock('../src/services/baileys.js', () => {
    importBaileys();
    return { BaileysService: BaileysConstructor };
  });
});

afterEach(() => {
  vi.doUnmock('../src/services/whatsapp.js');
  vi.doUnmock('../src/services/baileys.js');
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('backend configuration', () => {
  it.each([undefined, '', '   '])('defaults an unset or blank selector (%s) to webjs', async (value) => {
    vi.stubEnv('WHATSAPP_BACKEND', value);
    const { configuredBackend } = await import('../src/services/backend-factory.js');
    expect(configuredBackend()).toBe('webjs');
    expect(importWebjs).not.toHaveBeenCalled();
    expect(importBaileys).not.toHaveBeenCalled();
  });

  it.each([
    ['webjs', 'webjs'], [' WEBJS ', 'webjs'], ['baileys', 'baileys'], [' Baileys ', 'baileys'],
  ])('accepts and normalizes %s', async (value, expected) => {
    vi.stubEnv('WHATSAPP_BACKEND', value);
    const { configuredBackend } = await import('../src/services/backend-factory.js');
    expect(configuredBackend()).toBe(expected);
  });

  it('rejects invalid configuration before loading either driver', async () => {
    vi.stubEnv('WHATSAPP_BACKEND', 'unsupported');
    const { configuredBackend, createWhatsAppBackend } = await import('../src/services/backend-factory.js');
    expect(configuredBackend).toThrow("Unknown WHATSAPP_BACKEND 'unsupported'. Choose webjs or baileys.");
    await expect(createWhatsAppBackend()).rejects.toThrow(/Choose webjs or baileys/);
    expect(importWebjs).not.toHaveBeenCalled();
    expect(importBaileys).not.toHaveBeenCalled();
  });
});

describe('lazy backend loading', () => {
  it('loads the default browser driver without loading Baileys or its SQLite dependency', async () => {
    importBaileys.mockImplementation(() => { throw new Error('Baileys/native SQLite must remain unloaded'); });
    const { createWhatsAppBackend } = await import('../src/services/backend-factory.js');
    expect(importWebjs).not.toHaveBeenCalled();
    await expect(createWhatsAppBackend()).resolves.toBe(webjsBackend);
    expect(importWebjs).toHaveBeenCalledOnce();
    expect(WebjsConstructor).toHaveBeenCalledOnce();
    expect(importBaileys).not.toHaveBeenCalled();
    expect(BaileysConstructor).not.toHaveBeenCalled();
  });

  it('loads Baileys without importing or constructing the browser driver', async () => {
    vi.stubEnv('WHATSAPP_BACKEND', 'baileys');
    importWebjs.mockImplementation(() => { throw new Error('web.js/Puppeteer must remain unloaded'); });
    const { createWhatsAppBackend } = await import('../src/services/backend-factory.js');
    expect(importBaileys).not.toHaveBeenCalled();
    await expect(createWhatsAppBackend()).resolves.toBe(baileysBackend);
    expect(importBaileys).toHaveBeenCalledOnce();
    expect(BaileysConstructor).toHaveBeenCalledOnce();
    expect(importWebjs).not.toHaveBeenCalled();
    expect(WebjsConstructor).not.toHaveBeenCalled();
  });

  it('explains an optional dependency load failure and never falls back to a browser', async () => {
    vi.stubEnv('WHATSAPP_BACKEND', 'baileys');
    importBaileys.mockImplementation(() => { throw new Error('Cannot find package @whiskeysockets/baileys'); });
    const { createWhatsAppBackend } = await import('../src/services/backend-factory.js');
    const error = await createWhatsAppBackend().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('Could not load the Baileys backend');
    expect((error as Error).message).toContain('npm install --include=optional');
    expect((error as Error).message).toContain('supported Node.js version');
    expect((error as Error).cause).toBeInstanceOf(Error);
    expect(BaileysConstructor).not.toHaveBeenCalled();
    expect(importWebjs).not.toHaveBeenCalled();
    expect(WebjsConstructor).not.toHaveBeenCalled();
  });

  it('propagates construction failures without switching the selected backend', async () => {
    vi.stubEnv('WHATSAPP_BACKEND', 'baileys');
    const error = new Error('Session database is locked by another instance');
    BaileysConstructor.mockImplementation(function () { throw error; });
    const { createWhatsAppBackend } = await import('../src/services/backend-factory.js');
    await expect(createWhatsAppBackend()).rejects.toBe(error);
    expect(importWebjs).not.toHaveBeenCalled();
    expect(WebjsConstructor).not.toHaveBeenCalled();
  });
});
