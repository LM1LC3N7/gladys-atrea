// -----------------------------------------------------------------------------
// What must survive a restart, in /data (the only writable place of the
// container): the time of the last read of the unit (written at most once a
// minute, BEFORE the read), so a restart never reads the unit sooner than the
// interval; the identity learnt for the unit (its ID, the device it gives);
// where the configuration points (a stop pressed before the configuration is
// read again goes there); a kept stop; a password refused by the unit, as a
// 6-bit salted fingerprint only (64 values: it can never tell the password,
// it only says "the same one was refused" after a restart). No password, no
// session code, no personal data. The file is readable by the container user
// only (0600), bounded and repaired when read back.
//
// `load()` tells "no file" (null) from "a file that cannot be read" (it
// throws): an unreadable /data is never taken for an empty one (no new
// identity is learnt over it, no kept stop is forgotten by a later write). A
// special file (a FIFO, a device, a directory) is refused without opening it.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { lstat, readFile, rename, writeFile } from 'node:fs/promises';
import { DEFAULT_PORT, TIMINGS } from './constants.js';

export const STATE_FILE = '/data/atrea-state.json';
const MAX_SIZE = 4 * 1024;

export function fileStore(path = STATE_FILE) {
  // One write at a time: two saves never share the temporary file.
  let chain = Promise.resolve();
  return {
    async load() {
      let info;
      try {
        info = await lstat(path);
      } catch (err) {
        if (err?.code === 'ENOENT') return null;
        throw new Error(`state file unreadable (${err?.code ?? 'error'})`, { cause: err });
      }
      if (!info.isFile()) throw new Error('state file unreadable (not a regular file)');
      if (info.size > MAX_SIZE) throw new Error('state file too large');
      let text;
      try {
        text = await readFile(path, 'utf8');
      } catch (err) {
        throw new Error(`state file unreadable (${err?.code ?? 'error'})`, { cause: err });
      }
      if (text.length > MAX_SIZE) throw new Error('state file too large');
      try {
        return JSON.parse(text);
      } catch {
        throw new Error('state file not JSON');
      }
    },
    save(data) {
      const text = JSON.stringify(data);
      const write = chain.then(async () => {
        if (text.length > MAX_SIZE) throw new Error('state too large');
        const temporary = `${path}.tmp`;
        await writeFile(temporary, text, { mode: 0o600 });
        await rename(temporary, path);
      });
      chain = write.catch(() => {});
      return write;
    },
  };
}

/** For the tests: the same JSON round trip as the file; `failLoad` / `failSave` / `hang` simulate a broken /data. */
export function memoryStore(initial = null) {
  return {
    data: initial === null ? null : JSON.parse(JSON.stringify(initial)),
    saves: 0,
    failLoad: false,
    failSave: false,
    /** Saves (and loads) that never answer. */
    hang: false,
    hangLoad: false,
    async load() {
      if (this.hangLoad) return new Promise(() => {});
      if (this.failLoad) throw new Error('state file unreadable (EIO)');
      return this.data === null ? null : JSON.parse(JSON.stringify(this.data));
    },
    async save(data) {
      if (this.hang) return new Promise(() => {});
      if (this.failSave) throw new Error('EROFS');
      this.data = JSON.parse(JSON.stringify(data));
      this.saves += 1;
    },
  };
}

/** A short text of printable ASCII, bounded, else undefined. */
const shortText = (value, max) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= max &&
  /^[\x20-\x7e]*$/.test(value)
    ? value
    : undefined;

const HOST = /^[a-z0-9.-]{1,253}$/;
const PLATFORM = /^(unit|id-[a-z0-9-]{1,40})$/;

/** The 6-bit fingerprint of a password with a salt (0 to 63). */
export const passwordMark = (salt, password) =>
  createHash('sha256').update(`${salt}\n${password}`, 'utf8').digest()[0] & 0x3f;

/**
 * The persisted state, repaired and bounded:
 * - `lastAttemptAt`: wall time of the last read, or null (a time in the
 *   future counts as now: never a longer wait than the interval);
 * - `identity`: `{ unit, id, platform }` learnt for the unit at the address
 *   `unit`: its ID (null when the unit gives none) and the platform id of its
 *   Gladys device (frozen once learnt), or null;
 * - `target`: `{ unit, host, port }`, the address of the last configuration;
 * - `stopGuard`: `{ unit, host, port, pending, sent, seenOff, onReads,
 *   reasserts, sticky }`, a kept stop, or null. It holds no date: it is never
 *   lifted by the time. An unreadable count is 0 (never "used up").
 * - `refused`: `{ unit, salt, mark }`, a password refused twice in a row, or null.
 */
export function normalizeMemory(raw, now) {
  const data = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const identity = data.identity && typeof data.identity === 'object' ? data.identity : {};
  const guard = data.stopGuard && typeof data.stopGuard === 'object' ? data.stopGuard : {};
  const refused = data.refused && typeof data.refused === 'object' ? data.refused : {};
  const unit = shortText(identity.unit, 280);
  const platform =
    typeof identity.platform === 'string' && PLATFORM.test(identity.platform)
      ? identity.platform
      : undefined;
  const id = identity.id === null ? null : shortText(identity.id, 10);
  const guardTarget = normalizeTarget(guard);
  const count = (value, max) => (Number.isInteger(value) ? Math.min(max, Math.max(0, value)) : 0);
  const refusedUnit = shortText(refused.unit, 280);
  const salt =
    typeof refused.salt === 'string' && /^[0-9a-f]{16}$/.test(refused.salt)
      ? refused.salt
      : undefined;
  return {
    lastAttemptAt: Number.isFinite(data.lastAttemptAt) ? Math.min(data.lastAttemptAt, now) : null,
    identity: unit && platform && id !== undefined ? { unit, id, platform } : null,
    target: normalizeTarget(data.target) ?? null,
    stopGuard: guardTarget
      ? {
          ...guardTarget,
          // Anything but a clear false: the stop may not have landed (sent again first).
          pending: guard.pending !== false,
          // Anything but a clear true: never sent (no send counted).
          sent: guard.sent === true,
          seenOff: guard.seenOff === true,
          onReads: count(guard.onReads, 2),
          reasserts: count(guard.reasserts, TIMINGS.stopReasserts),
          sticky: guard.sticky === true,
        }
      : null,
    refused:
      refusedUnit &&
      salt &&
      Number.isInteger(refused.mark) &&
      refused.mark >= 0 &&
      refused.mark < 64
        ? { unit: refusedUnit, salt, mark: refused.mark }
        : null,
  };
}

/** Where a unit is (`{ unit, host, port }`), repaired, else undefined. */
export function normalizeTarget(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const unit = shortText(raw.unit, 280);
  const host = typeof raw.host === 'string' && HOST.test(raw.host) ? raw.host : undefined;
  const port =
    Number.isInteger(raw.port) && raw.port >= 1 && raw.port <= 65535 ? raw.port : DEFAULT_PORT;
  return unit && host ? { unit, host, port } : undefined;
}
