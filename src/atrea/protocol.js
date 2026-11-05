// -----------------------------------------------------------------------------
// The pages of the unit (pure): paths, the login answer, the registers page,
// the metadata page, and the values decoded from the registers.
//
// Parsing is linear and bounded (a regular expression over attributes of at
// most 300 characters, at most 8000 registers), keyed in a Map (no prototype
// to pollute), and strict: a value is a whole number written in digits, or it
// is unknown ('' is never 0).
// -----------------------------------------------------------------------------

import { createHash, randomInt } from 'node:crypto';
import {
  FORBIDDEN_MARK,
  LIMITS,
  PATHS,
  POWER,
  PROGRAMS,
  RANGES,
  READ_MODES,
  REG,
  STOPPED_MODES,
} from '../constants.js';

const LETTERS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const REGISTER = /^[A-Z]\d{5}$/;

/** The login key pyatrea sends: md5 of CR LF and the password (the unit's own protocol). */
export const loginKey = (password) =>
  createHash('md5').update(`\r\n${password}`, 'utf8').digest('hex');

/** Two random letters, as the web page adds to each request (no cache). */
const noise = (random = randomInt) => LETTERS[random(52)] + LETTERS[random(52)];

/** A path with the session code and the two letters (pyatrea `getURL`). */
export function withAuth(path, code, random) {
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}auth=${code ?? ''}&${noise(random)}`;
}

export const loginPath = (key, code, random) =>
  withAuth(`${PATHS.LOGIN}?magic=${key}`, code, random);
export const statusPath = (code, random) => withAuth(PATHS.STATUS, code, random);
export const paramsPath = (code, random) => withAuth(PATHS.PARAMS, code, random);

/**
 * The write of `values` ([register, value] pairs, in order), five digits
 * each: `&H1070900000`. Only registers of the documented shape, values 0 to
 * 65535; anything else throws (never sent).
 */
export function writePath(code, values, random) {
  let path = withAuth(PATHS.WRITE, code, random);
  for (const [register, value] of values) {
    if (!REGISTER.test(register) || !Number.isInteger(value) || value < 0 || value > 65535) {
      throw new Error('invalid write');
    }
    path += `&${register}${String(value).padStart(5, '0')}`;
  }
  return path;
}

/** Whether a page is the unit's "403 Forbidden" (a session is needed). */
export const isForbidden = (status, body) =>
  status === 401 || status === 403 || (typeof body === 'string' && body.includes(FORBIDDEN_MARK));

/**
 * The login answer: one XML element holding "denied" or the session code.
 * @returns {{ denied: true } | { code: string } | undefined} undefined when unreadable.
 */
export function parseLogin(body) {
  if (typeof body !== 'string' || body.length > 4096) return undefined;
  // Linear: trimmed first, the declaration cut by position, then one regex
  // whose parts never overlap (no backtracking on blanks).
  let text = body.trim();
  if (text.startsWith('<?xml')) {
    const end = text.indexOf('?>');
    if (end < 0 || end > 200) return undefined;
    text = text.slice(end + 2).trimStart();
  }
  const match = /^<([A-Za-z][\w-]{0,30})(?:\s[^<>]{0,200})?>([^<]{0,200})<\/\1>$/.exec(text);
  if (!match) return undefined;
  const value = match[2].trim();
  if (value === 'denied') return { denied: true };
  return LIMITS.code.test(value) ? { code: value } : undefined;
}

const ATTRIBUTE = /([A-Za-z][\w-]{0,30})\s*=\s*"([^"]{0,200})"/g;

function attributes(text) {
  const out = new Map();
  for (const [, name, value] of text.matchAll(ATTRIBUTE)) {
    if (!out.has(name)) out.set(name, value);
  }
  return out;
}

/**
 * The registers page: register -> raw text value (first one wins).
 * @returns {Map<string, string> | undefined} undefined when it is not a registers page.
 */
export function parseStatus(body) {
  if (typeof body !== 'string' || !/<(RD5WEB|PCOWEB)\b/.test(body)) return undefined;
  const values = new Map();
  let count = 0;
  for (const [, attrs] of body.matchAll(/<O\s([^<>]{0,300}?)\/?>/g)) {
    count += 1;
    if (count > LIMITS.maxRegisters) return undefined;
    const a = attributes(attrs);
    const id = a.get('I');
    const value = a.get('V');
    if (id && REGISTER.test(id) && value !== undefined && !values.has(id)) {
      values.set(id, value);
    }
  }
  return values;
}

/**
 * The metadata page: the registers flagged as warnings (W) and alerts (A).
 * @returns {{ warnings: string[], alerts: string[] } | undefined}
 */
export function parseParams(body) {
  if (typeof body !== 'string' || !/<params\b/.test(body)) return undefined;
  const warnings = [];
  const alerts = [];
  let count = 0;
  for (const [, attrs] of body.matchAll(/<i\s([^<>]{0,300}?)\/?>/g)) {
    count += 1;
    if (count > LIMITS.maxRegisters) return undefined;
    const a = attributes(attrs);
    const id = a.get('id');
    if (!id || !REGISTER.test(id)) continue;
    if (a.get('flag') === 'W') warnings.push(id);
    if (a.get('flag') === 'A') alerts.push(id);
  }
  return { warnings: [...new Set(warnings)], alerts: [...new Set(alerts)] };
}

/** A whole number written in digits (0 to 65535), else undefined. */
export function wholeNumber(raw) {
  if (typeof raw !== 'string' || !/^\d{1,5}$/.test(raw)) return undefined;
  const n = Number(raw);
  return n <= 65535 ? n : undefined;
}

/** A signed 16-bit tenth of a degree (HomeAssistant-Atrea `convert_temperature`), bounded. */
function temperature(raw, [min, max] = RANGES.temperature) {
  const n = wholeNumber(raw);
  if (n === undefined) return undefined;
  const value = (n > 32767 ? n - 65536 : n) / 10;
  return value >= min && value <= max ? value : undefined;
}

const flag = (raw) => (raw === '1' ? true : raw === '0' ? false : undefined);

const percent = (raw) => {
  const n = wholeNumber(raw);
  return n !== undefined && n <= 100 ? n : undefined;
};

/**
 * The unit ID (H12300-H12309, one character code each), FROZEN RULE: read up
 * to the first 0 (NUL), trailing spaces removed, any printable character
 * (0x20-0x7e) kept inside. A string; null when the unit gives none (the
 * registers missing, or an empty ID: never typed in); undefined when a
 * register is not a number or holds a code outside 0x20-0x7e.
 */
export function unitId(map) {
  if (REG.ID.every((register) => !map.has(register))) return null;
  let text = '';
  for (const register of REG.ID) {
    const code = wholeNumber(map.get(register));
    if (code === undefined) return undefined;
    if (code === 0) break;
    if (code < 0x20 || code > 0x7e) return undefined;
    text += String.fromCharCode(code);
  }
  text = text.replace(/ +$/, '');
  return text.length >= 1 ? text : null;
}

/**
 * The values read (only those readable; anything else is unknown).
 * `alarms`: { warnings, alerts } of the metadata page, when read.
 */
export function decodeStatus(map, alarms) {
  const v = {};
  const mode = wholeNumber(map.get(REG.MODE));
  if (mode !== undefined && mode < READ_MODES.length) {
    v.modeId = mode;
    v.mode = READ_MODES[mode];
    v.running = !STOPPED_MODES.has(mode);
  }
  const program = wholeNumber(map.get(REG.PROGRAM));
  if (program !== undefined && Object.hasOwn(PROGRAMS, program)) v.program = PROGRAMS[program];
  v.power = percent(map.get(REG.POWER_REQUESTED));
  v.powerCurrent = percent(map.get(REG.POWER_CURRENT));
  v.outdoor = temperature(map.get(REG.TEMP_OUTDOOR));
  v.supply = temperature(map.get(REG.TEMP_SUPPLY));
  v.extract = temperature(map.get(REG.TEMP_EXTRACT));
  v.exhaust = temperature(map.get(REG.TEMP_EXHAUST));
  v.indoor = temperature(map.get(REG.TEMP_INDOOR));
  v.outdoorAverage = temperature(map.get(REG.TEMP_OUTDOOR_AVERAGE));
  v.requested = temperature(map.get(REG.TEMP_REQUESTED), RANGES.requested);
  v.heating = flag(map.get(REG.HEATING));
  v.cooling = flag(map.get(REG.COOLING));
  v.filter = flag(map.get(REG.FILTER));
  const writable = wholeNumber(map.get(REG.WRITABLE_MODES));
  const circulation = wholeNumber(map.get(REG.CIRCULATION));
  if (writable !== undefined && circulation !== undefined) {
    // pyatrea `loadSupportedModes`: bit i of I12004, circulation modes (3, 4) only when H11700 != 0.
    v.writableModes = READ_MODES.slice(1, 8).filter((_, i) => {
      const id = i + 1;
      if ((id === 3 || id === 4) && circulation === 0) return false;
      return (writable & (1 << id)) !== 0;
    });
  }
  const [major, minor, patch] = REG.VERSION.map((r) => wholeNumber(map.get(r)));
  if (major !== undefined && minor !== undefined) {
    v.version = patch ? `${major}.${minor}.${patch}` : `${major}.${minor}`;
  }
  v.id = unitId(map);
  v.rd5 = map.has(REG.MODE);
  if (alarms) {
    const active = (list) => list.filter((r) => map.get(r) === '1');
    const alerts = active(alarms.alerts);
    const warnings = active(alarms.warnings);
    v.alertCount = alerts.length;
    v.warningCount = warnings.length;
    const codes = [...alerts, ...warnings];
    v.alarmCodes =
      codes.length === 0
        ? 'none'
        : codes.slice(0, LIMITS.alarmCodes).join(', ') +
          (codes.length > LIMITS.alarmCodes ? ', …' : '');
  }
  for (const key of Object.keys(v)) {
    if (v[key] === undefined) delete v[key];
  }
  if (!('id' in v)) v.idUnreadable = true;
  return v;
}

/** The power a command may write: a whole number 12 to 100 (a number or digits), else undefined. */
export function powerValue(value) {
  let n;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string' && /^\d{1,3}$/.test(value)) n = Number(value);
  return Number.isInteger(n) && n >= POWER.min && n <= POWER.max ? n : undefined;
}
