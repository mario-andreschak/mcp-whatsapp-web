import { readFileSync } from 'node:fs';

let cached: string | undefined;

/** The version recorded in package.json (two folders up from both src/utils and dist/utils). */
export function packageVersion(): string {
  if (cached) return cached;
  try {
    const raw = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: unknown };
    cached = typeof raw.version === 'string' && raw.version ? raw.version : 'unknown';
  } catch {
    cached = 'unknown';
  }
  return cached;
}
