import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { type Actor, SETTING_KEYS, type SettingsFile, SettingsFileSchema } from '@rideo/shared';
import { randomHex } from '../util/crypto';

/**
 * The studio's settings file, `<dataDir>/settings.json` (docs/design/settings.md#where-values-come-from): values keyed
 * by environment variable, written atomically with mode 0600 (it holds secrets). Keys that are not settings are
 * dropped on load, so a hand-edited file cannot reach environment-only configuration.
 */
export class SettingsStore {
  private file: SettingsFile = { version: 1, updatedAt: null, updatedBy: null, values: {} };
  /** Why the file could not be read (it is then treated as empty). */
  loadError: string | null = null;

  constructor(readonly path: string) {}

  get values(): Readonly<Record<string, string>> {
    return this.file.values;
  }

  get updatedAt(): string | null {
    return this.file.updatedAt;
  }

  get updatedBy(): Actor | null {
    return this.file.updatedBy;
  }

  async load(): Promise<this> {
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.loadError = (err as Error).message;
      return this;
    }
    try {
      const parsed = SettingsFileSchema.parse(JSON.parse(raw));
      const values: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed.values)) if (SETTING_KEYS.has(k)) values[k] = v;
      this.file = { ...parsed, values };
    } catch (err) {
      this.loadError = `settings.json is not valid: ${(err as Error).message}`;
    }
    return this;
  }

  /** Replaces the stored values (the caller has validated them). */
  async save(values: Record<string, string>, actor: Actor | null): Promise<void> {
    const next: SettingsFile = {
      version: 1,
      updatedAt: new Date().toISOString(),
      updatedBy: actor,
      values: Object.fromEntries(Object.entries(values).sort(([a], [b]) => a.localeCompare(b))),
    };
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${randomHex(4)}.tmp`;
    try {
      await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      await chmod(tmp, 0o600);
      await rename(tmp, this.path);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
    this.file = next;
    this.loadError = null;
  }
}
