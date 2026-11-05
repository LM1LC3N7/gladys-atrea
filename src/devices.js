// -----------------------------------------------------------------------------
// The unit -> one Gladys device and its states (pure).
//
// FROZEN RULE: `ext:<selector>:atrea:id-<unit ID>`, the ID the unit gives in
// registers H12300 to H12309 (lower case; any character but a-z, 0-9 becomes
// "-"), learnt at the first read and kept in /data for the address; a unit
// that gives no ID at all (registers missing) is `ext:<selector>:atrea:unit`.
// Another unit answering at the same address never takes over the device (and
// its history): its ID differs, the commands are refused until the test
// button accepts it, and it then becomes a new device. The feature roles (the
// last part of their external ids) are published forever: never rename them.
// Every role is always built, so a republished device never loses a feature.
//
// No switch, no writable binary: a "turn everything off" (Google Home, Alexa,
// HomeKit, MCP, `switch.*` scenes) never reaches the ventilation. The
// commands are one `text/select` (the mode), one `fan/percent` (the power, 12
// to 100 %) and one `button/push` (stop); the mode and the power are refused
// unless the configuration allows the commands; the stop is never held back by
// the option (src/app.js).
//
// Categories and units are those the core lists
// (DEVICE_FEATURE_UNITS_BY_CATEGORY): °C on temperature-sensor, percent on
// fan. The air flows (m³/h, only on the water-valve category in the core) are
// not published.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { FEATURES, MODES, POWER, RANGES, READ_MODES } from './constants.js';
import { DEVICE_NAME, FEATURE_NAMES, MODE_NAMES, word } from './i18n.js';

export const SERVICE = 'atrea';

/** The platform id of the device of a unit ID (or of a unit without ID). */
export function platformOf(id) {
  if (typeof id !== 'string' || id.length === 0) return 'unit';
  return `id-${id.toLowerCase().replace(/[^a-z0-9]/g, '-')}`;
}

const sensor = (definition) => ({
  read_only: true,
  has_feedback: false,
  keep_history: true,
  ...definition,
});
const binary = sensor({ category: C.UNKNOWN, type: T.SENSOR.BINARY, min: 0, max: 1 });
const text = sensor({ category: C.TEXT, type: T.TEXT.TEXT, min: 0, max: 0, keep_history: false });
const temperature = sensor({
  category: C.TEMPERATURE_SENSOR,
  type: T.SENSOR.DECIMAL,
  unit: U.CELSIUS,
  min: RANGES.temperature[0],
  max: RANGES.temperature[1],
});
const count = sensor({ category: C.UNKNOWN, type: T.SENSOR.INTEGER, min: 0, max: 1000 });

/** The features, by role, in display order. */
export const DEFINITIONS = {
  [FEATURES.MODE]: {
    category: C.TEXT,
    type: T.TEXT.SELECT,
    min: 0,
    max: 0,
    read_only: false,
    has_feedback: true,
    keep_history: false,
  },
  [FEATURES.CURRENT_MODE]: text,
  [FEATURES.PROGRAM]: text,
  [FEATURES.RUNNING]: binary,
  [FEATURES.POWER]: {
    category: C.FAN,
    type: T.FAN.PERCENT,
    unit: U.PERCENT,
    min: POWER.min,
    max: POWER.max,
    read_only: false,
    has_feedback: true,
    keep_history: true,
  },
  [FEATURES.POWER_CURRENT]: sensor({
    category: C.FAN,
    type: T.FAN.PERCENT,
    unit: U.PERCENT,
    min: 0,
    max: 100,
  }),
  [FEATURES.TEMP_OUTDOOR]: temperature,
  [FEATURES.TEMP_SUPPLY]: temperature,
  [FEATURES.TEMP_EXTRACT]: temperature,
  [FEATURES.TEMP_EXHAUST]: temperature,
  [FEATURES.TEMP_INDOOR]: temperature,
  [FEATURES.TEMP_OUTDOOR_AVERAGE]: temperature,
  [FEATURES.TEMP_REQUESTED]: { ...temperature, min: RANGES.requested[0], max: RANGES.requested[1] },
  [FEATURES.HEATING]: binary,
  [FEATURES.COOLING]: binary,
  [FEATURES.FILTER]: binary,
  [FEATURES.ALERT_COUNT]: count,
  [FEATURES.WARNING_COUNT]: count,
  [FEATURES.ALARM_CODES]: text,
  [FEATURES.STOP]: {
    category: C.BUTTON,
    type: T.BUTTON.PUSH,
    min: 0,
    max: 1,
    read_only: false,
    has_feedback: false,
    keep_history: false,
  },
};

export const ROLES = Object.keys(DEFINITIONS);

/** The value read for each numeric or binary role. */
const VALUE_OF = {
  [FEATURES.RUNNING]: 'running',
  [FEATURES.POWER]: 'power',
  [FEATURES.POWER_CURRENT]: 'powerCurrent',
  [FEATURES.TEMP_OUTDOOR]: 'outdoor',
  [FEATURES.TEMP_SUPPLY]: 'supply',
  [FEATURES.TEMP_EXTRACT]: 'extract',
  [FEATURES.TEMP_EXHAUST]: 'exhaust',
  [FEATURES.TEMP_INDOOR]: 'indoor',
  [FEATURES.TEMP_OUTDOOR_AVERAGE]: 'outdoorAverage',
  [FEATURES.TEMP_REQUESTED]: 'requested',
  [FEATURES.HEATING]: 'heating',
  [FEATURES.COOLING]: 'cooling',
  [FEATURES.FILTER]: 'filter',
  [FEATURES.ALERT_COUNT]: 'alertCount',
  [FEATURES.WARNING_COUNT]: 'warningCount',
};

export const deviceIds = (gladys, platform) => gladys.externalIds(SERVICE, platform);

/** The role of one of our feature external ids (any platform), else undefined. */
export function parseFeatureId(externalId) {
  if (typeof externalId !== 'string') {
    return undefined;
  }
  const match = new RegExp(`:${SERVICE}:(unit|id-[a-z0-9-]{1,40}):([a-z0-9-]+)$`).exec(externalId);
  return match && ROLES.includes(match[2]) ? { platform: match[1], role: match[2] } : undefined;
}

/** The Gladys device of the unit. */
export function buildDevice(gladys, { language, platform, id, version }) {
  const ids = deviceIds(gladys, platform);
  const params = [{ name: 'protocol', value: 'HTTP (local)' }];
  if (id) params.push({ name: 'unit_id', value: id });
  if (version) params.push({ name: 'firmware', value: version });
  return {
    name: word(DEVICE_NAME, language),
    external_id: ids.device,
    model: 'Atrea RD5',
    should_poll: false,
    features: ROLES.map((role) => ({
      name: word(FEATURE_NAMES[role], language),
      external_id: ids.feature(role),
      ...DEFINITIONS[role],
      ...(role === FEATURES.MODE
        ? {
            supported_options: MODES.map((value, index) => ({
              value,
              label: word(MODE_NAMES[value], language),
              sort_order: index,
            })),
          }
        : {}),
    })),
    params,
  };
}

/**
 * The states of the values read this time (a value not read is left out:
 * Gladys keeps its last one, never republished as new). A value outside the
 * bounds of its feature is dropped. Texts are stable English keys, whatever
 * the language (scenes keep working); a text is never a measure.
 */
export function deviceStates(ids, values) {
  const states = [];
  // The list only shows its options: another mode (off, rundown…) does not change it.
  if (MODES.includes(values.mode)) {
    states.push({ device_feature_external_id: ids.feature(FEATURES.MODE), text: values.mode });
  }
  if (READ_MODES.includes(values.mode)) {
    states.push({
      device_feature_external_id: ids.feature(FEATURES.CURRENT_MODE),
      text: values.mode,
    });
  }
  if (['manual', 'weekly', 'temporary'].includes(values.program)) {
    states.push({
      device_feature_external_id: ids.feature(FEATURES.PROGRAM),
      text: values.program,
    });
  }
  if (
    typeof values.alarmCodes === 'string' &&
    /^(none|[A-Z]\d{5}(, [A-Z]\d{5})*(, …)?)$/.test(values.alarmCodes)
  ) {
    states.push({
      device_feature_external_id: ids.feature(FEATURES.ALARM_CODES),
      text: values.alarmCodes,
    });
  }
  for (const [role, key] of Object.entries(VALUE_OF)) {
    let value = values[key];
    if (typeof value === 'boolean') value = value ? 1 : 0;
    const { min, max } = DEFINITIONS[role];
    if (Number.isFinite(value) && value >= min && value <= max) {
      states.push({ device_feature_external_id: ids.feature(role), state: value });
    }
  }
  return states;
}
