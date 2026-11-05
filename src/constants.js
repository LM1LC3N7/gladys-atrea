// -----------------------------------------------------------------------------
// Atrea constants: the local web interface of the RD5 regulation, feature
// roles, limits and timings.
//
// The unit answers plain HTTP (port 80) on the local network, the pages its
// own web interface reads. The paths, the registers and their meaning are
// those of pyatrea 0.10.0 (MIT) and HomeAssistant-Atrea 6.2.0 (Apache-2.0),
// both by Juraj Nyiri; Atrea publishes no documentation of this interface.
// Only these requests are ever sent:
//   - GET /config/login.cgi?magic=<md5("\r\n" + password)>&auth=<code>&<2 letters>:
//     opens a session; the answer is one XML element holding "denied" or the
//     session code;
//   - GET /config/xml.xml?auth=<code>&<2 letters>: the registers, one
//     `<O I="H10705" V="1"/>` element each (a page holding "HTTP: 403
//     Forbidden" when the session is not valid);
//   - GET /user/params.xml?auth=<code>&<2 letters>: the register metadata,
//     read for the warning (flag W) and alert (flag A) lists only;
//   - GET /config/xml.cgi?auth=<code>&<2 letters>&<register><5 digits>...:
//     the writes, only the registers listed below.
// Nothing else: no firmware, no settings, no clock, no alarm reset.
// -----------------------------------------------------------------------------

export const DEFAULT_PORT = 80;

export const PATHS = {
  LOGIN: '/config/login.cgi',
  STATUS: '/config/xml.xml',
  PARAMS: '/user/params.xml',
  WRITE: '/config/xml.cgi',
};

/** The text of the page the unit sends instead of a page when the session is not valid. */
export const FORBIDDEN_MARK = 'HTTP: 403 Forbidden';

/**
 * The registers read (pyatrea / HomeAssistant-Atrea, RD5 regulation):
 * temperatures are signed 16-bit tenths of a degree.
 */
export const REG = {
  /** The current mode (AtreaMode, below). */
  MODE: 'H10705',
  /** The air handling program: 0 manual, 1 weekly, 2 temporary. */
  PROGRAM: 'H10700',
  /** The fan power asked, in % (12 to 100). */
  POWER_REQUESTED: 'H10714',
  /** The fan power applied now, in %. */
  POWER_CURRENT: 'H10704',
  /** The temperature asked, in tenths of a degree (read only here). */
  TEMP_REQUESTED: 'H10706',
  /** The forced mode (an input D1-D4, IN1, IN2... forcing the unit). */
  FORCED_MODE: 'H10712',
  TEMP_OUTDOOR: 'I10211',
  TEMP_SUPPLY: 'I10212',
  TEMP_EXTRACT: 'I10213',
  TEMP_EXHAUST: 'I10214',
  TEMP_INDOOR: 'I10215',
  TEMP_OUTDOOR_AVERAGE: 'I11420',
  HEATING: 'C10215',
  COOLING: 'C10216',
  /** The filter warning ("change the filters"). */
  FILTER: 'D11183',
  /** The modes the unit lets the user write: a bit per mode (0 to 7). */
  WRITABLE_MODES: 'I12004',
  /** 0: circulation modes (3, 4) not available. */
  CIRCULATION: 'H11700',
  /** The firmware version: major, minor, patch. */
  VERSION: ['I00020', 'I00021', 'I00022'],
  /** The unit ID, one character per register (pyatrea `getID`). */
  ID: [
    'H12300',
    'H12301',
    'H12302',
    'H12303',
    'H12304',
    'H12305',
    'H12306',
    'H12307',
    'H12308',
    'H12309',
  ],
};

/** The registers written (pyatrea `setProgram`, `setMode`, `setPower`). */
export const WRITE_REG = {
  /** The air handling program of power, mode, temperature (and zone for H10703). */
  PROGRAM: ['H10700', 'H10701', 'H10702', 'H10703'],
  /** The temporary program writes the first three only (pyatrea). */
  PROGRAM_TEMPORARY: ['H10700', 'H10701', 'H10702'],
  MODE: 'H10709',
  POWER: 'H10708',
};

export const PROGRAMS = { 0: 'manual', 1: 'weekly', 2: 'temporary' };

/** H10705 as read (index = value): stable keys (pyatrea AtreaMode). */
export const READ_MODES = [
  'off',
  'automatic',
  'ventilation',
  'circulation-ventilation',
  'circulation',
  'night-precooling',
  'disbalance',
  'overpressure',
  'periodic-ventilation',
  'startup',
  'rundown',
  'defrosting',
  'external',
  'hp-defrosting',
  'in1',
  'in2',
  'd1',
  'd2',
  'd3',
  'd4',
];

/** The modes of the list in Gladys: those the unit may let the user write (bits 1 to 7 of I12004). */
export const MODES = [
  'automatic',
  'ventilation',
  'circulation-ventilation',
  'circulation',
  'night-precooling',
  'disbalance',
  'overpressure',
];

/** The modes in which the unit is stopped or stopping (never "on" for the kept stop). */
export const STOPPED_MODES = new Set([0, 10]);

/** The fan power the unit accepts (pyatrea `setPower`). */
export const POWER = { min: 12, max: 100 };

/** Feature roles (the last part of the feature external ids): frozen. */
export const FEATURES = {
  MODE: 'mode',
  CURRENT_MODE: 'current-mode',
  PROGRAM: 'program',
  RUNNING: 'running',
  POWER: 'fan-power',
  POWER_CURRENT: 'fan-power-current',
  TEMP_OUTDOOR: 'temperature-outdoor',
  TEMP_SUPPLY: 'temperature-supply',
  TEMP_EXTRACT: 'temperature-extract',
  TEMP_EXHAUST: 'temperature-exhaust',
  TEMP_INDOOR: 'temperature-indoor',
  TEMP_OUTDOOR_AVERAGE: 'temperature-outdoor-average',
  TEMP_REQUESTED: 'temperature-requested',
  HEATING: 'heating',
  COOLING: 'cooling',
  FILTER: 'filter-warning',
  ALERT_COUNT: 'alert-count',
  WARNING_COUNT: 'warning-count',
  ALARM_CODES: 'alarm-codes',
  STOP: 'stop',
};

/** The value of a button press (Gladys sends 1). */
export const PRESSED = 1;

export const ACTIONS = {
  TEST_CONNECTION: 'test_connection',
};

/** The poll interval of the configuration, in seconds. */
export const POLL_INTERVAL = {
  min: 30,
  max: 3600,
  default: 60,
};

/** Plausible values (anything else is not a measure). */
export const RANGES = {
  temperature: [-50, 100],
  /** pyatrea `setTemperature`: 10 to 40 °C. */
  requested: [10, 40],
  percent: [0, 100],
};

export const LIMITS = {
  /** Gladys: 300 states per minute for the whole integration. */
  statesPerMinute: 300,
  statesPerRequest: 100,
  /** The registers page and the metadata page (a few tens of KB on a unit). */
  maxBody: 512 * 1024,
  maxHeader: 8 * 1024,
  /** At most this many registers read in one page. */
  maxRegisters: 8000,
  /** At most this many codes in the alarm text. */
  alarmCodes: 10,
  /** The password typed (bytes). */
  password: 64,
  /** A session code given by the unit. */
  code: /^[0-9A-Za-z]{1,32}$/,
};

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

export const TIMINGS = {
  /** Opening the TCP connection of a request. */
  connectTimeout: 3 * SECOND,
  /** One whole answer of a poll, and the longest silence inside it. */
  requestTimeout: 10 * SECOND,
  idleTimeout: 5 * SECOND,
  /** The stop: a stalled answer (no byte for this long) is cut and tried again. */
  stopIdle: SECOND,
  /** A refused connection of a stop is tried again this often, until its deadline. */
  connectRetry: 250,
  /** A stop reaffirmed by a read leaves at least this long after the read closed the line. */
  reassertDelay: SECOND,
  /** Failed reads: 30 s, 1, 2, then 5 minutes, never shorter than the interval. */
  backoff: [30 * SECOND, MINUTE, 2 * MINUTE, 5 * MINUTE],
  /** `getConfig()` failed in `connected`: tried again after 5 s, 15 s, 30 s, then every minute. */
  configRetry: [5 * SECOND, 15 * SECOND, 30 * SECOND, MINUTE],
  /** The metadata page (warnings, alerts): read again every hour; spaced up to an hour on failures. */
  paramsEvery: HOUR,
  paramsRetry: [MINUTE, 2 * MINUTE, 5 * MINUTE, 15 * MINUTE, 30 * MINUTE, HOUR],
  /** The time of the last read goes to /data at most once a minute. */
  attemptWriteEvery: MINUTE,
  /** The publisher sends what is pending every second; unchanged states again every 30 min. */
  flushInterval: SECOND,
  stateHeartbeat: 30 * MINUTE,
  /**
   * Commands (Gladys waits 5 s for the ack): the fresh read and the write
   * must leave by 3.5 s after the click, or the command is refused unsent;
   * the read back that confirms it is awaited until 4.3 s, after which the
   * command is "sent, without confirmation".
   */
  commandSendBy: 3_500,
  commandAnswerBy: 4_300,
  commandMinRead: 200,
  commandMinSend: 200,
  /** Reads after a command, spaced: its effect, then a check. */
  followUps: [5 * SECOND, 20 * SECOND],
  /** A sent command keeps its guard until a read shows what it asked, or 90 s. */
  guard: 90 * SECOND,
  /** /data: a read waits this long at most for it (never blocking), a load too. */
  attemptSaveWait: 500,
  loadWait: SECOND,
  /** A poll due while a command or a stop holds the line is tried again this much later. */
  busyRetry: SECOND,
  /** A stop pressed while one runs with less than this left of its window starts a new one after it. */
  stopJoinMin: SECOND,
  /** The stop waits this long at most for /data to keep it before its first byte (never blocking). */
  stopSaveWait: 150,
  /** A stop sent and not confirmed is reaffirmed by the next reads, three sends at most. */
  stopReasserts: 3,
};
