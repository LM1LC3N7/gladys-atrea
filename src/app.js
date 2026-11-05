// -----------------------------------------------------------------------------
// The integration: the unit typed in the configuration (its address and the
// password of its web page), one read of its registers page every poll
// interval, the Gladys device and its states, the transport badge, the "Test
// the connection" button, and the commands. index.js only wires the SDK
// handlers to it (src/handlers.js).
//
// One HTTP request at a time to the unit (the "line"), each on its own
// connection closed after the answer; ONE session kept (the code the unit
// gives at sign-in, in memory only): the unit accepts few signed-in users, so
// the integration signs in again only when the unit answers its "403
// Forbidden" page, never in parallel, never in a loop (one sign-in per
// request at most). A poll is one session of the line; a command takes the
// line from a poll (the poll is dropped, nothing of it published); "Stop the
// unit" takes it from anything.
//
// The password: two "denied" answers in a row (or a session refused right
// after a sign-in, twice) make a refusal, kept in /data as a 6-bit salted
// fingerprint: no sign-in is tried again on its own, until another password
// is saved or the test button succeeds (one sign-in per press). A single
// "denied" is tried once more at the next read (the unit also says "denied"
// when too many users are signed in).
//
// Reads follow the rules learnt on the previous modules:
//   - never sooner than the interval after the last one: not for the test
//     button, a Discovery scan, a reconnection to Gladys, a configuration
//     saved unchanged, nor a restart of the container (the time of the last
//     read is kept in /data, written at most once a minute, BEFORE the read);
//   - an answer that arrives for an old configuration (generation) publishes
//     nothing and sets no status; a read begun before a command left is not
//     applied (requests are ordered by the time they left, never by the time
//     they answered); a value not read this time is never republished as new;
//   - the metadata page (warnings, alerts) is secondary: read every hour, its
//     failure (refused, timeout, unreadable) never costs the values, never
//     signs in, and is tried again spaced up to an hour.
//
// Commands (mode, fan power):
//   - refused unless "Allow the commands" is on, checked on arrival and again
//     right before the write;
//   - decided on a fresh read in the same line (mode, program, power, writable
//     modes, unit ID), never on the state in memory; refused when a value
//     cannot be read, when the unit ID differs from the one learnt, when
//     /data cannot be read; the power is refused on a unit off or stopping
//     (it could start it) and while a stop sent from Gladys is kept; a mode
//     the unit does not list as writable is refused; a mode chosen from Gladys
//     is a start: it lifts a kept stop (/data forgets it BEFORE the first
//     byte, else nothing is sent); under the weekly program, the program
//     becomes temporary with the write (as the web page and pyatrea do);
//   - written within 3.5 s of the click or refused unsent; confirmed only by
//     a read back equal to the value asked, by 4.3 s; a read back equal to
//     the state before is "not applied yet"; else "sent, without
//     confirmation" and spaced reads; never retried; one at a time;
//   - the ack never waits for a publication to Gladys.
//
// "Stop the unit" protects (manual program and mode off: H10700-H10703 = 0,
// H10709 = 0): never held back by the option, another command, a read in
// progress or stuck, a failed read, a backoff, the unit ID, /data or a
// configuration not read yet; tried again until 3.5 s after the press (the
// write is idempotent); cancels a command not written yet. It is then KEPT
// (in /data, with its address): never lifted by the time, only by a mode
// chosen from Gladys with the option, or by the unit read running twice in a
// row after it was seen off. A stop that never left (unit unreachable, no
// session possible) is never given up: it leaves first at every read, and as
// soon as a password is saved or the test button succeeds; only a send that
// left counts as a try. Once sent and not confirmed, the reads that see the
// unit running send it again, three sends at most. A stop that may not have
// landed when the container stopped is sent again at start from /data,
// before the configuration is read (without a session: the password is not
// known before the configuration; it then leaves first once it is read).
//
// In-memory times (deadlines, guards, the time of the last read) are on a
// monotonic clock (`clock`); the wall clock (`now`) only for /data.
// -----------------------------------------------------------------------------

import { randomBytes } from 'node:crypto';
import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { addressKey, normalizeConfig } from './config.js';
import {
  FEATURES,
  MODES,
  PRESSED,
  READ_MODES,
  SECOND,
  STOPPED_MODES,
  TIMINGS,
  WRITE_REG,
} from './constants.js';
import { AtreaError, ERROR_KINDS, errorReason, httpGet, tcpConnect } from './atrea/http.js';
import {
  decodeStatus,
  isForbidden,
  loginKey,
  loginPath,
  paramsPath,
  parseLogin,
  parseParams,
  parseStatus,
  powerValue,
  statusPath,
  writePath,
} from './atrea/protocol.js';
import { buildDevice, deviceIds, deviceStates, parseFeatureId, platformOf } from './devices.js';
import { ERRORS, T, age, join, word } from './i18n.js';
import { StatePublisher } from './publisher.js';
import { fileStore, normalizeMemory, passwordMark } from './store.js';

const both = (en, fr) => ({ en, fr });

/** A refusal: the message Gladys shows. */
class Refusal extends Error {}

const freshUnit = () => ({
  /** The values of the last read (only those read that time). */
  values: undefined,
  online: undefined,
  failures: 0,
  wait: undefined,
  error: undefined,
  timer: undefined,
  running: undefined,
  followUps: new Set(),
});

const monotonic = () => performance.now();

/** The stop: manual program, mode off (pyatrea `setProgram(MANUAL)` + `setMode(OFF)`). */
const STOP_WRITES = [...WRITE_REG.PROGRAM.map((r) => [r, 0]), [WRITE_REG.MODE, 0]];

/** Errors after which a stop is tried again within its window (the write is idempotent). */
const STOP_AGAIN = new Set([
  ERROR_KINDS.UNREACHABLE,
  ERROR_KINDS.CLOSED,
  ERROR_KINDS.TIMEOUT,
  ERROR_KINDS.STALLED,
  ERROR_KINDS.PROTOCOL,
]);

export class AtreaApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'atrea' }),
    connect = tcpConnect,
    now = Date.now,
    clock = monotonic,
    timers = globalThis,
    store = fileStore(),
    random,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.connect = connect;
    this.now = now;
    this.clock = clock;
    this.timers = timers;
    this.store = store;
    this.random = random;
    this.publisher = new StatePublisher({ gladys, logger, now: clock, timers });
    this.config = normalizeConfig();
    this.memory = normalizeMemory(null, now());
    /** /data could not be read: nothing learnt nor written over it. */
    this.memoryUnreadable = false;
    this.memoryLoaded = false;
    this.unit = freshUnit();
    this.generation = 0;
    this.started = false;
    /** The session code the unit gave (memory only; '' before a sign-in). */
    this.code = '';
    /** "denied" answers (or sessions refused right after a sign-in) in a row. */
    this.denials = 0;
    /** The password was refused twice in a row: no sign-in on its own. */
    this.refused = false;
    /** The warning and alert lists of the metadata page (secondary). */
    this.alarms = undefined;
    this.paramsDue = -Infinity;
    this.paramsFailures = 0;
    /** The time of the last read sent to the unit (monotonic; /data keeps it within a minute). */
    this.lastAttemptAt = -Infinity;
    this.lastStatus = undefined;
    this.published = undefined;
    this.badge = undefined;
    /** The session on the line: { kind: 'read' | 'command' | 'protect', abort(), done }. */
    this.active = undefined;
    /** Commands and stops getting ready to take the line (a poll does not start meanwhile). */
    this.reserved = 0;
    this.inFlight = undefined;
    this.protecting = undefined;
    this.protectUntil = -Infinity;
    /** Counts the stops: a command that sees it change before its write gives way. */
    this.protectSeq = 0;
    /** When the last write left (a read begun before it is not applied). */
    this.lastSentAt = -Infinity;
    /** When the last mode (a start) left. */
    this.lastStartAt = -Infinity;
    /** A mode or a power written and not confirmed yet: a stop after it is sticky. */
    this.startOpen = false;
    /** The unit ID read when it differs from the one kept for this address (commands refused). */
    this.mismatch = undefined;
    /** The unit ID could not be read at the last read (commands refused). */
    this.idUnreadable = false;
    /** Value key -> { from, expected, moved, until }: a command sent, not seen yet. */
    this.guards = new Map();
    /** The kept stop (see the header), or undefined. */
    this.stopGuard = undefined;
    this.reassertTimer = undefined;
    this.configTimer = undefined;
    this.configFailures = 0;
    this.connectSeq = 0;
  }

  /** The monotonic clock (every in-memory time). */
  mono() {
    return this.clock();
  }

  /** Waits for `promise` at most `ms` (a /data that never answers never blocks). */
  async bounded(promise, ms) {
    let timer;
    const timeout = Symbol('timeout');
    try {
      return await Promise.race([
        promise,
        new Promise((resolve) => {
          timer = this.timers.setTimeout(() => resolve(timeout), ms);
        }),
      ]).then((value) => {
        if (value === timeout) throw new Error('/data did not answer in time');
        return value;
      });
    } finally {
      this.timers.clearTimeout(timer);
    }
  }

  // --- /data -------------------------------------------------------------------

  /** Reads /data once (again after a failure), bounded in time: unreadable is never "empty". */
  async loadMemory() {
    let raw;
    try {
      raw = await this.bounded(this.store.load(), TIMINGS.loadWait);
    } catch (err) {
      if (!this.memoryUnreadable) {
        this.logger.warn(`Atrea: /data unreadable (${err.message}); nothing is written over it`);
      }
      this.memoryUnreadable = true;
      return;
    }
    const loaded = normalizeMemory(raw, this.now());
    this.memoryUnreadable = false;
    this.memoryLoaded = true;
    // What runs now wins over what was kept (a stop sent since the file was read).
    this.memory = {
      lastAttemptAt: this.memory.lastAttemptAt ?? loaded.lastAttemptAt,
      identity: this.memory.identity ?? loaded.identity,
      target: this.memory.target ?? loaded.target,
      stopGuard: this.guardRecord() ?? loaded.stopGuard,
      refused: this.memory.refused ?? loaded.refused,
    };
    if (!this.stopGuard && loaded.stopGuard) {
      this.stopGuard = { ...loaded.stopGuard, sentAt: this.mono(), restored: true };
      this.logger.info('Atrea: a stop kept in /data is still kept');
    }
  }

  async saveMemory() {
    if (this.memoryUnreadable) {
      throw new Error('/data unreadable');
    }
    await this.store.save(this.memory);
  }

  /** A background save: logged on failure, never awaited by a protective path. */
  saveSoon() {
    const saving = this.saveMemory();
    saving.catch((err) => this.logger.warn(`Saving the state to /data failed: ${err.message}`));
    return saving;
  }

  /** The kept stop as /data keeps it (no date: it never ends by the time). */
  guardRecord(guard = this.stopGuard) {
    if (!guard) return null;
    const { unit, host, port, pending, sent, seenOff, onReads, reasserts, sticky } = guard;
    return { unit, host, port, pending, sent, seenOff, onReads, reasserts, sticky };
  }

  /** Keeps the stop guard in /data (or clears it); never awaited without a bound. */
  persistStopGuard() {
    const next = this.guardRecord();
    if (JSON.stringify(next) === JSON.stringify(this.memory.stopGuard ?? null)) {
      return Promise.resolve();
    }
    this.memory.stopGuard = next;
    if (this.memoryUnreadable) return Promise.resolve();
    return this.saveSoon();
  }

  /**
   * Container start, before Gladys is reached: a stop that may not have
   * landed when the container stopped is sent again now, from /data (its
   * address), without the configuration nor a first read.
   */
  async boot() {
    await this.loadMemory();
    if (this.stopGuard?.pending) {
      this.logger.warn('Atrea: a stop may not have landed before the restart, sent again');
      this.flushStop();
    }
  }

  // --- Lifecycle -------------------------------------------------------------

  /**
   * `fresh`: started for a new address while running (a read may go at
   * once); otherwise the first read waits for the interval after the last read.
   */
  async start(raw = {}, { fresh = false } = {}) {
    this.stop();
    this.config = normalizeConfig(raw);
    const generation = this.generation;
    await this.unit.running;
    if (generation !== this.generation) {
      return;
    }
    if (!this.memoryLoaded) {
      await this.loadMemory();
      if (generation !== this.generation) {
        return;
      }
    }
    this.unit = freshUnit();
    this.code = '';
    this.denials = 0;
    this.alarms = undefined;
    this.paramsDue = -Infinity;
    this.paramsFailures = 0;
    this.mismatch = undefined;
    this.idUnreadable = false;
    this.published = undefined;
    this.badge = undefined;
    this.lastStatus = undefined;
    this.refused = this.refusalKept();
    this.publisher.start();
    const target = this.configTarget();
    if (target && JSON.stringify(target) !== JSON.stringify(this.memory.target)) {
      this.memory.target = target;
      if (!this.memoryUnreadable) this.saveSoon().catch(() => {});
    }
    if (!this.config.address) {
      await this.publishAll();
      return;
    }
    await this.setStatus(false, this.status());
    if (generation !== this.generation) {
      return;
    }
    // A stop that never left (or may not have landed) goes first.
    if (this.ownGuard()?.pending) {
      this.flushStop();
    }
    const wait = fresh ? 0 : this.firstWait();
    if (wait > 0) {
      this.schedule(wait);
      await this.publishAll();
      return;
    }
    await this.tick();
  }

  /** Whether /data keeps a refusal of this very password for this unit. */
  refusalKept() {
    const r = this.memory.refused;
    if (!r || r.unit !== this.unitKey() || this.config.password === undefined) return false;
    return passwordMark(r.salt, this.config.password) === r.mark;
  }

  /** The unit of the configuration, as kept in /data: its address. */
  unitKey() {
    return this.config.address ? addressKey(this.config.address) : '';
  }

  configTarget() {
    if (!this.config.address) return undefined;
    return { unit: this.unitKey(), host: this.config.address.host, port: this.config.address.port };
  }

  guardTarget(guard) {
    return { unit: guard.unit, host: guard.host, port: guard.port };
  }

  /** The kept stop, when it belongs to the unit of the configuration. */
  ownGuard() {
    return this.stopGuard && this.stopGuard.unit === this.unitKey() ? this.stopGuard : undefined;
  }

  /** The identity learnt for the unit of the configuration, or undefined. */
  identity() {
    const kept = this.memory.identity;
    return kept && kept.unit === this.unitKey() ? kept : undefined;
  }

  /** The wait before the first read after a container start, from the time kept in /data. */
  firstWait() {
    const stored = this.memory.lastAttemptAt;
    if (stored === null) {
      return 0;
    }
    const now = this.now();
    // The time kept may be up to a minute older than the last read (written at
    // most once a minute): the last read counts as that minute later, never later than now.
    const latest = Math.min(stored + TIMINGS.attemptWriteEvery, now);
    this.lastAttemptAt = Math.max(this.lastAttemptAt, this.mono() - (now - latest));
    const due = stored + TIMINGS.attemptWriteEvery + this.interval;
    return Math.min(this.interval, Math.max(0, due - now));
  }

  /**
   * A new configuration or a restart: the reads and commands of this run end.
   * A stop in flight goes on (bounded by its own deadline), unless the
   * container shuts down.
   */
  stop({ shutdown = false } = {}) {
    this.generation += 1;
    this.clearTimer();
    for (const handle of this.unit.followUps) {
      this.timers.clearTimeout(handle);
    }
    this.unit.followUps.clear();
    if (shutdown || this.active?.kind !== 'protect') {
      this.active?.abort('stopped');
    }
    this.publisher.stop();
    this.guards.clear();
    if (this.reassertTimer) {
      this.timers.clearTimeout(this.reassertTimer);
      this.reassertTimer = undefined;
    }
    if (shutdown && this.configTimer) {
      this.timers.clearTimeout(this.configTimer);
      this.configTimer = undefined;
    }
    if (shutdown) this.closed = true;
  }

  /** The container stops: everything ends, /data keeps the last state (bounded wait). */
  async shutdown() {
    this.stop({ shutdown: true });
    if (!this.memoryUnreadable && this.memoryLoaded) {
      this.memory.stopGuard = this.guardRecord();
      await this.bounded(this.saveMemory(), TIMINGS.attemptSaveWait).catch(() => {});
    }
  }

  clearTimer() {
    if (this.unit.timer) {
      this.timers.clearTimeout(this.unit.timer);
      this.unit.timer = undefined;
    }
  }

  /**
   * Connected to Gladys (the first time and after every reconnection): the
   * configuration is read; when that fails, it is tried again, spaced (5 s,
   * 15 s, 30 s, then every minute), without end, with the status saying so.
   */
  async connectedWith(getConfig) {
    const seq = ++this.connectSeq;
    if (this.configTimer) {
      this.timers.clearTimeout(this.configTimer);
      this.configTimer = undefined;
    }
    let raw;
    try {
      raw = await getConfig();
    } catch (err) {
      if (seq !== this.connectSeq || this.closed) return;
      const wait =
        TIMINGS.configRetry[Math.min(this.configFailures, TIMINGS.configRetry.length - 1)];
      this.configFailures += 1;
      this.logger.warn(
        `Atrea: reading the configuration failed (${err?.message ?? 'error'}); next try in ${Math.round(wait / 1000)} s`,
      );
      this.lastStatus = undefined;
      await this.setStatus(false, T.configUnread(age(wait)));
      if (seq !== this.connectSeq || this.closed) return;
      this.configTimer = this.timers.setTimeout(() => {
        this.configTimer = undefined;
        this.connectedWith(getConfig).catch(() => this.logger.error('Atrea: start failed'));
      }, wait);
      return;
    }
    if (seq !== this.connectSeq) return;
    this.configFailures = 0;
    await this.connected(raw);
  }

  /**
   * The configuration read. The first time, start; after a reconnection,
   * resend what Gladys keeps in memory only (status, Discovery list, badge)
   * and the last states, without reading the unit.
   */
  async connected(raw = {}) {
    if (!this.started) {
      this.started = true;
      await this.start(raw);
      return;
    }
    await this.applyConfig(raw, { reconnected: true });
  }

  async configUpdated(raw = {}) {
    if (!this.started) {
      this.started = true;
      await this.start(raw);
      return;
    }
    await this.applyConfig(raw, { reconnected: false });
  }

  /** A configuration read again: a new address restarts; a new password signs in again. */
  async applyConfig(raw, { reconnected }) {
    const next = normalizeConfig(raw);
    const previous = this.config;
    if (
      JSON.stringify(next.address ?? null) !== JSON.stringify(previous.address ?? null) ||
      next.invalid !== previous.invalid
    ) {
      await this.start(raw, { fresh: true });
      return;
    }
    this.config = next;
    const changed = next.password !== previous.password;
    if (changed) {
      // New credentials: a new session, the refusal always lifted (the mark of
      // /data only serves after a restart, when the old password is not known).
      this.code = '';
      this.denials = 0;
      this.refused = false;
      if (this.memory.refused?.unit === this.unitKey()) {
        this.memory.refused = null;
        if (!this.memoryUnreadable) this.saveSoon().catch(() => {});
      }
      this.logger.info('Atrea: new password saved');
    } else if (!reconnected && this.refused) {
      // The same password saved again by the user: one more try, as the test button.
      this.refused = false;
      this.denials = 1;
      this.logger.info('Atrea: password saved again, one more try');
    }
    if ((changed || !reconnected) && this.ownGuard()?.pending && !this.config.badPassword) {
      this.flushStop();
    }
    this.rescheduleOnNewInterval(previous);
    if (this.config.allowCommands !== previous.allowCommands) {
      this.logger.info(`Atrea commands ${this.config.allowCommands ? 'allowed' : 'disabled'}`);
    }
    if (reconnected) {
      this.published = undefined;
      this.badge = undefined;
      this.lastStatus = undefined;
      this.gladys.forgetPublishedStates?.();
      await this.publishAll();
    } else {
      if (this.config.language !== previous.language) this.published = undefined;
      await this.publishAll();
    }
  }

  /** A new interval: the next read follows it, counted from the last read. */
  rescheduleOnNewInterval(previous) {
    const u = this.unit;
    if (
      this.config.pollInterval !== previous.pollInterval &&
      this.config.address &&
      !u.running &&
      u.online !== false &&
      u.timer
    ) {
      this.schedule();
    }
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  // --- The line (one HTTP request at a time) -----------------------------------

  /** Runs `fn(line)` holding the line; the line ends when it does. */
  async useLine(kind, fn, target = this.configTarget()) {
    let finish;
    const record = {
      kind,
      target,
      aborted: false,
      current: undefined,
      done: new Promise((resolve) => {
        finish = resolve;
      }),
      abort: (message) => {
        record.aborted = true;
        record.current?.abort(message);
      },
    };
    this.active = record;
    try {
      if (!target) {
        throw new AtreaError(ERROR_KINDS.UNREACHABLE, 'no address');
      }
      return await fn(record);
    } finally {
      record.current?.abort('ended');
      if (this.active === record) {
        this.active = undefined;
      }
      finish();
    }
  }

  /** Ends the session on the line when it is one of `kinds`, and waits for its end. */
  async takeLine(kinds) {
    const current = this.active;
    if (current && kinds.includes(current.kind)) {
      current.abort('line taken');
      await current.done;
    }
  }

  /** One GET on the line. */
  async get(line, path, options) {
    if (line.aborted) {
      throw new AtreaError(ERROR_KINDS.ABORTED, 'line taken');
    }
    const request = httpGet({
      host: line.target.host,
      port: line.target.port,
      path,
      connect: this.connect,
      timers: this.timers,
      now: () => this.mono(),
      ...options,
    });
    line.current = request;
    try {
      return await request.promise;
    } finally {
      if (line.current === request) line.current = undefined;
    }
  }

  /** Whether a sign-in may be tried for this line (never to another address than the configuration's). */
  loginAllowed(line) {
    return (
      line.target.unit === this.unitKey() &&
      typeof this.config.password === 'string' &&
      this.config.password !== '' &&
      !this.refused
    );
  }

  /** A sign-in (one request): the session code, or DENIED / NO_LOGIN. */
  async login(line, options) {
    if (!this.loginAllowed(line)) {
      throw new AtreaError(ERROR_KINDS.NO_LOGIN, 'no sign-in possible');
    }
    let answer;
    try {
      answer = await this.get(
        line,
        loginPath(loginKey(this.config.password), this.code, this.random),
        { ...options, beforeSend: undefined, startBy: undefined },
      );
    } catch (err) {
      if (err?.sent) {
        // Cut by us after it left: the unit may have opened a session we never saw.
        // The next "denied" may come from that lost place: it never counts as a refusal.
        this.loginCut = true;
      } else if (err && typeof err === 'object') {
        // Never left (refused connection, too late): not a sign-in tried.
        err.loginUnsent = true;
      }
      throw err;
    }
    if (answer.status !== 200) {
      throw new AtreaError(ERROR_KINDS.HTTP, 'sign-in answered badly', { status: answer.status });
    }
    const parsed = parseLogin(answer.body);
    if (!parsed) {
      throw new AtreaError(ERROR_KINDS.PROTOCOL, 'sign-in answer unreadable');
    }
    if (parsed.denied) {
      this.noteDenied();
      throw new AtreaError(ERROR_KINDS.DENIED, 'password denied');
    }
    this.code = parsed.code;
    this.loginCut = false;
  }

  /**
   * A GET that needs the session: with the code kept; on the "403" page, one
   * sign-in (when allowed) and the request once more. `notApplied` is called
   * when the unit answered the "403" page (the request did nothing).
   */
  async authed(line, build, options = {}, { login = true, notApplied, onLogin } = {}) {
    const first = await this.get(line, build(this.code), options);
    if (!isForbidden(first.status, first.body)) {
      return first;
    }
    notApplied?.();
    if (!login) {
      throw new AtreaError(ERROR_KINDS.FORBIDDEN, 'session needed');
    }
    this.code = '';
    try {
      await this.login(line, options.loginOptions ?? options);
    } catch (err) {
      // Counted as tried only when the sign-in left (or was answered): a
      // connection refused before it is tried again within the budget.
      if (!err?.loginUnsent && err?.kind !== ERROR_KINDS.NO_LOGIN) onLogin?.();
      throw err;
    }
    onLogin?.();
    const second = await this.get(line, build(this.code), options);
    if (isForbidden(second.status, second.body)) {
      notApplied?.();
      // A session refused right after a sign-in: counted as a refusal of the password.
      this.code = '';
      this.noteDenied();
      throw new AtreaError(ERROR_KINDS.DENIED, 'session refused right after the sign-in');
    }
    return second;
  }

  /** A "denied" (or a session refused right after a sign-in): the second in a row is a refusal. */
  noteDenied() {
    if (this.loginCut) {
      this.loginCut = false;
      this.logger.info('Atrea: denied after a sign-in we cut; not counted as a refusal');
      return;
    }
    this.denials += 1;
    if (this.denials < 2 || this.refused) return;
    this.refused = true;
    this.logger.warn('Atrea: the password was refused twice in a row; no sign-in tried on its own');
    if (this.config.password === undefined) return;
    const salt = randomBytes(8).toString('hex');
    this.memory.refused = {
      unit: this.unitKey(),
      salt,
      mark: passwordMark(salt, this.config.password),
    };
    if (!this.memoryUnreadable) this.saveSoon().catch(() => {});
  }

  /** A request answered within a valid session: the refusal count starts again. */
  noteSession() {
    this.denials = 0;
    const u = this.unit;
    if (u.online === false && [ERROR_KINDS.DENIED, ERROR_KINDS.NO_LOGIN].includes(u.error)) {
      // A session works now: the last read's refusal is no longer the state (read again soon).
      u.online = u.values ? true : undefined;
      u.error = undefined;
    }
    if (this.refused) {
      this.refused = false;
      this.logger.info('Atrea: the password works again');
    }
    if (this.memory.refused && this.memory.refused.unit === this.unitKey()) {
      this.memory.refused = null;
      if (!this.memoryUnreadable) this.saveSoon().catch(() => {});
    }
  }

  /** The registers page, read in `line`: the decoded values, or an error. */
  async readStatus(line, options, { login = true } = {}) {
    const answer = await this.authed(line, (code) => statusPath(code, this.random), options, {
      login,
    });
    if (answer.status !== 200) {
      throw new AtreaError(ERROR_KINDS.HTTP, 'registers page answered badly', {
        sent: true,
        status: answer.status,
      });
    }
    const map = parseStatus(answer.body);
    if (!map) {
      throw new AtreaError(ERROR_KINDS.PROTOCOL, 'registers page unreadable', { sent: true });
    }
    this.noteSession();
    return { map, values: decodeStatus(map, this.alarms) };
  }

  // --- Polling ---------------------------------------------------------------

  get interval() {
    return this.config.pollInterval * SECOND;
  }

  /** The earliest time the next polling read may go: the interval after the last one. */
  get due() {
    return this.lastAttemptAt + this.interval;
  }

  /** The next read: after its backoff, else the interval after the last one began; never sooner. */
  schedule(delay) {
    const u = this.unit;
    this.clearTimer();
    if (this.closed) return;
    const now = this.mono();
    let wait = delay ?? (u.online === false ? u.wait : this.due - now);
    wait = Math.max(wait ?? this.interval, Math.min(this.interval, this.due - now), 0);
    const generation = this.generation;
    u.timer = this.timers.setTimeout(() => {
      u.timer = undefined;
      if (generation === this.generation && u === this.unit) {
        this.tick().catch(() => this.logger.error('Atrea refresh failed'));
      }
    }, wait);
  }

  /** One read at a time: a tick during a read joins it. */
  tick() {
    const u = this.unit;
    if (!u.running) {
      u.running = this.run().finally(() => {
        u.running = undefined;
      });
    }
    return u.running;
  }

  /**
   * Keeps the time of this read; when the write of the minute is due, in
   * /data BEFORE the read (bounded wait: a stuck /data never stops the reads).
   */
  async noteAttempt() {
    this.lastAttemptAt = this.mono();
    const now = this.now();
    const stored = this.memory.lastAttemptAt;
    if (stored === null || now - stored >= TIMINGS.attemptWriteEvery || now < stored) {
      this.memory.lastAttemptAt = now;
      if (!this.memoryUnreadable) {
        await this.bounded(this.saveMemory(), TIMINGS.attemptSaveWait).catch((err) =>
          this.logger.warn(`Saving the state to /data failed: ${err.message}`),
        );
      }
    }
  }

  async run() {
    const generation = this.generation;
    if (!this.config.address || this.closed) {
      return;
    }
    if (this.active || this.reserved > 0) {
      this.schedule(TIMINGS.busyRetry);
      return;
    }
    // A stop that never left goes first (unless no session can be tried: then it waits).
    const guard = this.ownGuard();
    if (guard?.pending && !guard.sent && !this.protecting && !this.refused) {
      await this.flushStop();
      if (generation !== this.generation) return;
      if (this.active || this.reserved > 0) {
        this.schedule(TIMINGS.busyRetry);
        return;
      }
    }
    if (this.refused || this.config.badPassword) {
      // No automatic sign-in: the status says why; the test button or a new password resumes.
      await this.publishAll();
      // Checked again at the interval, never at once (no read went, `due` does not move).
      if (generation === this.generation) this.schedule(this.interval);
      return;
    }
    const startedAt = this.mono();
    await this.noteAttempt();
    if (generation !== this.generation) {
      return;
    }
    if (this.active || this.reserved > 0) {
      this.schedule(TIMINGS.busyRetry);
      return;
    }
    let values;
    let failure;
    try {
      values = await this.useLine('read', (line) => this.readAll(line));
    } catch (err) {
      failure = err;
    }
    if (generation !== this.generation) {
      return;
    }
    let delay;
    if (failure?.kind === ERROR_KINDS.ABORTED) {
      this.logger.debug('Atrea: read dropped, a command took the line');
    } else if (failure) {
      delay = this.failed(failure);
    } else if (startedAt <= this.lastSentAt) {
      this.logger.debug('Atrea: read begun before a command, not applied');
    } else {
      this.applyRead(values);
    }
    await this.publishAll();
    if (generation === this.generation) {
      this.schedule(delay);
    }
  }

  /** The registers page, then the metadata page when due (secondary: never blocking). */
  async readAll(line) {
    const options = { timeoutMs: TIMINGS.requestTimeout, idleMs: TIMINGS.idleTimeout };
    const { map, values } = await this.readStatus(line, options);
    if (this.mono() >= this.paramsDue) {
      try {
        const answer = await this.authed(line, (code) => paramsPath(code, this.random), options, {
          login: false,
        });
        const parsed = answer.status === 200 ? parseParams(answer.body) : undefined;
        if (!parsed) {
          throw new AtreaError(ERROR_KINDS.PROTOCOL, 'metadata page unreadable');
        }
        this.alarms = parsed;
        this.paramsFailures = 0;
        this.paramsDue = this.mono() + TIMINGS.paramsEvery;
        return decodeStatus(map, this.alarms);
      } catch (err) {
        if (err.kind === ERROR_KINDS.ABORTED) throw err;
        const wait =
          TIMINGS.paramsRetry[Math.min(this.paramsFailures, TIMINGS.paramsRetry.length - 1)];
        this.paramsFailures += 1;
        this.paramsDue = this.mono() + wait;
        this.logger.warn(
          `Atrea: metadata page not read (${errorReason(err)}), tried again in ${Math.round(wait / 1000)} s`,
        );
      }
    }
    return values;
  }

  /** A read: the values of this read only (a value not read is unknown). */
  applyRead(values) {
    const u = this.unit;
    u.online = true;
    u.failures = 0;
    u.wait = undefined;
    u.error = undefined;
    u.values = values;
    this.checkIdentity(values);
    this.observe(values);
  }

  /**
   * The identity of the unit: its ID (H12300-H12309), learnt at the first
   * read for this address and kept in /data with the device it gives. Another
   * ID read means another unit may answer at the address: the commands
   * (except the stop) are refused until the test button accepts it. An
   * unreadable ID is never "another unit" (commands refused, nothing learnt);
   * nothing is written over an unreadable /data (learnt in memory only).
   */
  checkIdentity(values) {
    if (values.idUnreadable) {
      this.idUnreadable = true;
      return;
    }
    this.idUnreadable = false;
    const seen = values.id ?? null;
    const kept = this.identity();
    if (!kept) {
      this.memory.identity = { unit: this.unitKey(), id: seen, platform: platformOf(seen) };
      this.mismatch = undefined;
      if (!this.memoryUnreadable) this.saveSoon().catch(() => {});
      return;
    }
    if (kept.id === seen) {
      this.mismatch = undefined;
      return;
    }
    if (kept.id === null && seen !== null) {
      // An ID read where none was: learnt, the device stays the same (no move of history).
      kept.id = seen;
      if (!this.memoryUnreadable) this.saveSoon().catch(() => {});
      this.mismatch = undefined;
      return;
    }
    if (seen === null) {
      // The registers are gone: unreadable, never another unit.
      this.idUnreadable = true;
      return;
    }
    if (this.mismatch !== seen) {
      this.logger.warn(
        `Atrea: unit ID changed (${kept.id} -> ${seen}); commands refused until the test button accepts the unit`,
      );
    }
    this.mismatch = seen;
  }

  /** A failed read: the delay before the next one. */
  failed(err) {
    const u = this.unit;
    const reason = errorReason(err);
    const wait = Math.max(
      this.interval,
      TIMINGS.backoff[Math.min(u.failures, TIMINGS.backoff.length - 1)],
    );
    u.failures += 1;
    u.online = false;
    u.wait = wait;
    u.error = err?.kind ?? 'error';
    this.logger.warn(`Atrea: ${reason}; next try in ${Math.round(wait / 1000)} s`);
    return wait;
  }

  /** The connection status of the configuration screen. */
  status() {
    const u = this.unit;
    const c = this.config;
    if (!c.address) {
      return c.invalid ? T.invalid(c.invalid) : T.noHost;
    }
    let text;
    if (c.badPassword) {
      text = T.badPassword;
    } else if (this.refused) {
      text = T.refused;
    } else if (u.online === false) {
      const wait = age(u.wait ?? this.interval);
      if (u.error === ERROR_KINDS.NO_LOGIN) text = T.needPassword;
      else if (u.error === ERROR_KINDS.DENIED) text = T.deniedOnce(wait);
      else if (
        [
          ERROR_KINDS.UNREACHABLE,
          ERROR_KINDS.TIMEOUT,
          ERROR_KINDS.CLOSED,
          ERROR_KINDS.STALLED,
        ].includes(u.error)
      ) {
        text = T.unreachable(addressKey(c.address), wait);
      } else {
        text = T.failing(u.error ?? 'error', wait);
      }
    } else if (u.online === true && this.mismatch !== undefined) {
      text = T.otherUnit(this.identity()?.id ?? '?', this.mismatch);
    } else if (u.online === undefined) {
      text =
        u.timer && this.due > this.mono() ? T.waiting(age(this.due - this.mono())) : T.connecting;
    } else {
      text = T.connected(T.summary(u.values ?? {}));
      if (this.idUnreadable) text = join(text, T.noId);
      if (u.values && !u.values.rd5) text = join(text, T.notRd5);
    }
    const guard = this.ownGuard();
    if (guard) {
      if (guard.pending && !guard.sent) text = join(text, T.stopWaiting);
      else if (!guard.seenOff && guard.reasserts >= TIMINGS.stopReasserts) {
        text = join(text, T.stopNotApplied);
      } else text = join(text, T.stopKept);
    }
    if (this.memoryUnreadable) {
      text = join(text, T.dataUnreadable);
    }
    return both(text.en.replace(/ {2,}/g, ' '), text.fr.replace(/ {2,}/g, ' '));
  }

  async updateStatus() {
    await this.setStatus(this.unit.online === true && Boolean(this.config.address), this.status());
  }

  // --- Gladys ----------------------------------------------------------------

  /** The external ids of the device of the unit, once its identity is known. */
  ids() {
    const identity = this.identity();
    return identity ? deviceIds(this.gladys, identity.platform) : undefined;
  }

  createdDevice() {
    const id = this.ids()?.device;
    return id ? (this.gladys.devices ?? []).find((d) => d?.external_id === id) : undefined;
  }

  async publishAll() {
    const generation = this.generation;
    await this.publishDevices();
    if (generation !== this.generation) {
      return;
    }
    this.queueStates();
    await this.flush();
    if (generation !== this.generation) {
      return;
    }
    await this.publishBadge();
    if (generation !== this.generation) {
      return;
    }
    await this.updateStatus();
  }

  async flush() {
    await this.publisher
      .flush()
      .catch((err) => this.logger.warn(`Sending to Gladys failed: ${err.message}`));
  }

  /** The device, once the unit answered and its identity is known (every feature, always). */
  async publishDevices() {
    const identity = this.identity();
    if (this.unit.online !== true || !identity) {
      return;
    }
    const devices = [
      buildDevice(this.gladys, {
        language: this.config.language,
        platform: identity.platform,
        id: identity.id,
        version: this.unit.values?.version,
      }),
    ];
    const json = JSON.stringify(devices);
    if (json === this.published) {
      return;
    }
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.published = json;
    } catch (err) {
      this.logger.warn(`Publishing the discovered devices failed: ${err.message}`);
    }
  }

  createdFeatures() {
    return new Set((this.createdDevice()?.features ?? []).map((f) => f?.external_id));
  }

  /** Pushes the given values (only these) to the created features of the device of the unit. */
  queueValues(values, created = this.createdFeatures()) {
    const ids = this.ids();
    if (!ids || this.mismatch !== undefined) return;
    for (const { device_feature_external_id: id, ...value } of deviceStates(ids, values)) {
      if (created.has(id)) {
        this.publisher.push(id, value);
      }
    }
  }

  queueStates(created) {
    if (this.unit.online === true && this.unit.values) {
      this.queueValues(this.unit.values, created);
    }
  }

  async publishBadge() {
    const device = this.createdDevice();
    const online = this.unit.online;
    if (!device || (online === undefined && this.config.address)) {
      return;
    }
    const entries = [
      {
        external_id: device.external_id,
        transport:
          online === true && this.mismatch === undefined
            ? DEVICE_TRANSPORTS.LOCAL
            : DEVICE_TRANSPORTS.UNREACHABLE,
      },
    ];
    const json = JSON.stringify(entries);
    if (json === this.badge) {
      return;
    }
    try {
      await this.gladys.publishTransports(entries);
      this.badge = json;
    } catch (err) {
      this.logger.warn(`Transport badge failed: ${err.message}`);
    }
  }

  /** A device was created (or updated): send its last values at once (read, never republished as new by a timer). */
  async deviceCreated(device) {
    this.badge = undefined;
    const created = this.createdFeatures();
    for (const f of device?.features ?? []) {
      created.add(f?.external_id);
    }
    this.queueStates(created);
    await this.flush();
    await this.publishBadge();
  }

  async deviceDeleted(device) {
    this.badge = undefined;
    if (typeof device?.external_id === 'string') {
      this.publisher.forget(device.external_id);
    }
  }

  /** The Discovery tab asks for a scan: the device sent again (no read). */
  async scan() {
    this.published = undefined;
    await this.publishDevices();
  }

  // --- Configuration button ------------------------------------------------------

  /**
   * A read now, unless the last one is more recent than the interval (then
   * its result). A refused password gets ONE sign-in per press; a unit ID that
   * changed is accepted (without a read).
   */
  async testConnection() {
    if (!this.config.address) {
      return this.status();
    }
    if (this.mismatch !== undefined) {
      const accepted = this.mismatch;
      const previous = this.memory.identity;
      this.memory.identity = { unit: this.unitKey(), id: accepted, platform: platformOf(accepted) };
      try {
        await this.bounded(this.saveMemory(), TIMINGS.attemptSaveWait);
      } catch {
        this.memory.identity = previous;
        return join(this.status(), T.dataUnreadable);
      }
      this.mismatch = undefined;
      this.published = undefined;
      this.logger.info('Atrea: new unit ID accepted');
      await this.publishAll();
      return T.accepted(accepted);
    }
    const u = this.unit;
    const current = () => JSON.parse(this.lastStatus ?? '[false,null]')[1] ?? this.status();
    if (u.running) {
      await u.running;
      return current();
    }
    const now = this.mono();
    if (now < this.due) {
      const waited = T.waiting(age(this.due - now));
      return Number.isFinite(this.lastAttemptAt) && u.online !== undefined
        ? join(join(current(), T.lastRead(age(now - this.lastAttemptAt))), waited)
        : waited;
    }
    if (this.refused) {
      // One sign-in for this press: a second "denied" refuses again at once.
      this.refused = false;
      this.denials = 1;
    }
    this.clearTimer();
    await this.tick();
    return current();
  }

  // --- Commands --------------------------------------------------------------------

  refusal(text) {
    return new Refusal(word(text, this.config.language));
  }

  async setValue(_device, feature, value) {
    // The deadlines count from the arrival of the command, before any wait.
    const received = this.mono();
    const parsed = parseFeatureId(feature?.external_id);
    const role = parsed?.role;
    if (role === FEATURES.STOP) {
      if (value !== PRESSED && value !== String(PRESSED)) {
        throw this.refusal(ERRORS.badButton);
      }
      // The address of the configuration, else (configuration not read yet) the
      // one the kept stop was sent to, else the last one kept in /data.
      if (!this.configTarget() && !this.stopGuard && !this.memory.target && !this.memoryLoaded) {
        // Pressed before /data was read (bounded: a stuck /data costs 1 s at most).
        await this.loadMemory();
      }
      const target =
        this.configTarget() ??
        (this.stopGuard ? this.guardTarget(this.stopGuard) : undefined) ??
        this.memory.target ??
        undefined;
      if (!target) {
        throw this.refusal(ERRORS.noHost);
      }
      return this.protect(received, target);
    }
    let plan;
    if (role === FEATURES.MODE) {
      // Strictly one of the values of the select: never trimmed, re-cased nor a number.
      if (typeof value !== 'string' || !MODES.includes(value)) {
        throw this.refusal(ERRORS.badValue);
      }
      plan = { role, key: 'modeId', expected: READ_MODES.indexOf(value), register: WRITE_REG.MODE };
    } else if (role === FEATURES.POWER) {
      const power = powerValue(value);
      if (power === undefined) {
        throw this.refusal(ERRORS.badPower);
      }
      plan = { role, key: 'power', expected: power, register: WRITE_REG.POWER };
    } else {
      throw this.refusal(ERRORS.readOnly);
    }
    if (!this.config.address) {
      throw this.refusal(ERRORS.noHost);
    }
    if (!this.config.allowCommands) {
      throw this.refusal(ERRORS.disabled);
    }
    plan.platform = parsed.platform;
    const identity = this.identity();
    if (identity && parsed.platform !== identity.platform) {
      throw this.refusal(ERRORS.otherUnit);
    }
    if (this.inFlight) {
      throw this.refusal(ERRORS.busy);
    }
    if (this.protecting) {
      throw this.refusal(ERRORS.protectMeanwhile);
    }
    const promise = this.command(plan, received);
    this.inFlight = promise;
    try {
      return await promise;
    } finally {
      if (this.inFlight === promise) {
        this.inFlight = undefined;
      }
    }
  }

  /** The values a command read or confirmed: in memory and to Gladys in the background. */
  noteValues(values, { fromCommand = false } = {}) {
    if (this.unit.online !== true || !this.unit.values) {
      return;
    }
    Object.assign(this.unit.values, values);
    this.observe(values, { fromCommand });
    this.queueValues(values);
    this.flush().catch(() => {});
  }

  async command(plan, received) {
    const generation = this.generation;
    const seq = this.protectSeq;
    const sendBy = received + TIMINGS.commandSendBy;
    const answerBy = received + TIMINGS.commandAnswerBy;
    const check = () => {
      if (!this.config.allowCommands) {
        throw this.refusal(ERRORS.disabled);
      }
      if (generation !== this.generation || !this.config.address) {
        throw this.refusal(ERRORS.configChanged);
      }
      if (seq !== this.protectSeq) {
        throw this.refusal(ERRORS.protectMeanwhile);
      }
    };
    const state = { written: false, seq };
    this.reserved += 1;
    try {
      if (this.memoryUnreadable) {
        throw this.refusal(ERRORS.dataUnreadable);
      }
      if (plan.role === FEATURES.POWER && this.ownGuard()) {
        throw this.refusal(ERRORS.stopKept);
      }
      await this.takeLine(['read']);
      if (this.active) {
        throw this.refusal(this.active.kind === 'protect' ? ERRORS.protectMeanwhile : ERRORS.busy);
      }
      check();
      return await this.useLine('command', (line) =>
        this.commandLine(line, plan, { check, sendBy, answerBy, state }),
      );
    } catch (err) {
      throw this.commandError(err, plan, state);
    } finally {
      this.reserved -= 1;
      if (state.liftSaved && !state.written && this.stopGuard) {
        // The mode never left: /data keeps the stop again.
        this.memory.stopGuard = undefined;
        this.persistStopGuard().catch(() => {});
      }
    }
  }

  /** The answer to Gladys of a command that did not end confirmed. */
  commandError(err, plan, state) {
    if (err instanceof Refusal) {
      return err;
    }
    const reason = errorReason(err);
    const what = `${plan.role} ${plan.expected}`;
    if (!state.written) {
      this.logger.warn(`Atrea: command NOT sent (${what}): ${reason}`);
      if (err?.kind === ERROR_KINDS.LATE) return this.refusal(ERRORS.tooSlow);
      if (err?.kind === ERROR_KINDS.ABORTED) {
        return this.refusal(
          state.seq !== this.protectSeq ? ERRORS.protectMeanwhile : ERRORS.configChanged,
        );
      }
      if (err?.kind === ERROR_KINDS.NO_LOGIN) return this.refusal(ERRORS.noLogin);
      if (err?.kind === ERROR_KINDS.DENIED) return this.refusal(ERRORS.denied);
      return this.refusal(ERRORS.notSent(reason));
    }
    if (state.refused) {
      this.logger.warn(`Atrea: command refused by the unit (${what}): ${reason}`);
      return this.refusal(ERRORS.refused(reason));
    }
    return this.unconfirmed(plan, state, reason);
  }

  /** A command that may have reached the unit: guard, spaced reads, "sent, without confirmation". */
  unconfirmed(plan, state, reason) {
    this.guards.set(plan.key, {
      from: state.from,
      expected: plan.expected,
      moved: false,
      until: this.mono() + TIMINGS.guard,
    });
    this.followUp();
    this.logger.warn(`Atrea: command sent, NOT confirmed (${plan.role}): ${reason}`);
    if (state.backEqualsBefore) {
      return this.refusal(ERRORS.notYetApplied);
    }
    return this.refusal(ERRORS.sentUnconfirmed(reason));
  }

  async commandLine(line, plan, { check, sendBy, answerBy, state }) {
    // The state just before acting, read now in this line, never the one in memory.
    const budget = () => sendBy - TIMINGS.commandMinSend - this.mono();
    if (budget() < TIMINGS.commandMinRead) {
      throw this.refusal(ERRORS.tooSlow);
    }
    let fresh;
    try {
      ({ values: fresh } = await this.readStatus(line, {
        timeoutMs: budget(),
        idleMs: budget(),
        startBy: sendBy - TIMINGS.commandMinSend - TIMINGS.commandMinRead,
      }));
    } catch (err) {
      if ([ERROR_KINDS.ABORTED, ERROR_KINDS.NO_LOGIN, ERROR_KINDS.DENIED].includes(err.kind)) {
        throw err;
      }
      if (err.kind === ERROR_KINDS.LATE) throw this.refusal(ERRORS.tooSlow);
      throw this.refusal(ERRORS.unknownState(errorReason(err)));
    }
    check();
    // The identity read in the same line: another unit refuses the command.
    this.checkIdentity(fresh);
    if (this.mismatch !== undefined) {
      throw this.refusal(ERRORS.otherUnit);
    }
    const identity = this.identity();
    if (!identity || this.idUnreadable || (fresh.id ?? null) !== identity.id) {
      throw this.refusal(ERRORS.noIdentity);
    }
    if (identity.platform !== plan.platform) {
      throw this.refusal(ERRORS.otherUnit);
    }
    if (fresh.modeId === undefined) {
      throw this.refusal(ERRORS.unknownMode);
    }
    // A fresh read of a command never sends a stop again.
    this.noteValues(fresh, { fromCommand: true });
    const isMode = plan.role === FEATURES.MODE;
    if (isMode) {
      if (!fresh.writableModes) {
        throw this.refusal(ERRORS.modesUnknown);
      }
      if (!fresh.writableModes.includes(READ_MODES[plan.expected])) {
        throw this.refusal(ERRORS.modeNotWritable);
      }
    } else {
      if (fresh.power === undefined) {
        throw this.refusal(ERRORS.unknownState(word(ERRORS.unreadable, this.config.language)));
      }
      if (!fresh.running) {
        throw this.refusal(ERRORS.unitOff);
      }
      if (this.ownGuard()) {
        throw this.refusal(ERRORS.stopKept);
      }
    }
    if (fresh.program === undefined) {
      throw this.refusal(ERRORS.unknownState(word(ERRORS.unreadable, this.config.language)));
    }
    if (isMode && this.ownGuard()) {
      // A mode lifts the kept stop: /data must forget it BEFORE the first byte
      // (a restart would else stop the unit again), or nothing is sent.
      this.memory.stopGuard = null;
      try {
        await this.bounded(this.saveMemory(), TIMINGS.stopSaveWait);
      } catch {
        this.memory.stopGuard = this.guardRecord();
        throw this.refusal(ERRORS.dataUnreadable);
      }
      state.liftSaved = true;
      check();
    }
    state.from = fresh[plan.key];
    if (state.from === plan.expected && !this.guardActive(plan.key)) {
      if (isMode && this.ownGuard()) {
        this.liftStopGuard('mode chosen, unit already in it');
      }
      this.logger.info(`Atrea: ${plan.role} already so, nothing sent`);
      return;
    }
    const writes = [];
    if (fresh.program === 'weekly') {
      // As the web page and pyatrea: a change under the weekly program makes it temporary.
      writes.push(...WRITE_REG.PROGRAM_TEMPORARY.map((r) => [r, 2]));
    }
    writes.push([plan.register, plan.expected]);
    this.logger.info(`Atrea: ${plan.role} (${plan.expected})`);
    const previousStart = this.lastStartAt;
    const previousOpen = this.startOpen;
    const previousGuard = this.stopGuard;
    const notApplied = () => {
      // The "403" page: the write did nothing; the kept stop stays kept.
      state.written = false;
      this.lastStartAt = previousStart;
      this.startOpen = previousOpen;
      if (previousGuard && !this.stopGuard) {
        this.stopGuard = previousGuard;
        this.persistStopGuard().catch(() => {});
      }
    };
    const answer = await this.authed(
      line,
      (code) => writePath(code, writes, this.random),
      {
        timeoutMs: Math.max(100, answerBy - this.mono()),
        idleMs: Math.max(100, answerBy - this.mono()),
        startBy: sendBy,
        beforeSend: () => {
          check();
          state.written = true;
          this.lastSentAt = this.mono();
          this.startOpen = true;
          if (isMode) {
            this.lastStartAt = this.mono();
            if (this.stopGuard && this.stopGuard.unit === this.unitKey()) {
              this.stopGuard = undefined;
            }
          }
        },
        loginOptions: { timeoutMs: Math.max(100, sendBy - this.mono()) },
      },
      { notApplied },
    );
    if (answer.status !== 200) {
      if (answer.status >= 400 && answer.status < 500 && ![408, 429].includes(answer.status)) {
        state.refused = true;
        notApplied();
        state.written = true;
      }
      throw new AtreaError(ERROR_KINDS.HTTP, 'write answered badly', {
        sent: true,
        status: answer.status,
      });
    }
    // Confirmed only by the value read back equal to the value asked.
    const left = answerBy - this.mono();
    if (left < 50) {
      throw new AtreaError(ERROR_KINDS.TIMEOUT, 'no time left to read back', { sent: true });
    }
    const { values: back } = await this.readStatus(
      line,
      { timeoutMs: left, idleMs: left },
      { login: false },
    );
    if (back[plan.key] !== plan.expected) {
      if (back[plan.key] !== undefined) {
        state.backEqualsBefore = back[plan.key] === state.from;
        this.noteValues(back, { fromCommand: true });
      }
      throw new AtreaError(ERROR_KINDS.PROTOCOL, 'read back differs', { sent: true });
    }
    this.guards.delete(plan.key);
    this.startOpen = false;
    this.noteValues(back, { fromCommand: true });
    this.logger.info(`Atrea: ${plan.role} confirmed by the unit`);
  }

  // --- The stop (protective) -----------------------------------------------

  /** Sends the kept stop (pending) in the background; logged, never thrown. */
  flushStop() {
    const guard = this.stopGuard;
    if (!guard?.pending) return Promise.resolve();
    return this.protect(this.mono(), this.guardTarget(guard), { reassert: true }).catch((err) =>
      this.logger.warn(`Atrea: kept stop sent again: ${err.message}`),
    );
  }

  /** A second press while one runs joins it. */
  async protect(received, target, { reassert = false } = {}) {
    if (this.protecting) {
      if (
        this.protectTarget === target.unit &&
        this.protectUntil - this.mono() >= TIMINGS.stopJoinMin
      ) {
        return this.protecting;
      }
      await this.protecting.catch(() => {});
      return this.protect(this.mono(), target, { reassert });
    }
    this.protectUntil = received + TIMINGS.commandSendBy;
    this.protectTarget = target.unit;
    const promise = this.sendStop(received, target, { reassert });
    this.protecting = promise;
    try {
      return await promise;
    } finally {
      if (this.protecting === promise) {
        this.protecting = undefined;
      }
      // The status says where the stop stands at once, never at the next read only.
      if (!this.closed) this.updateStatus().catch(() => {});
    }
  }

  /**
   * Never held back: takes the line from anything, one write, without a
   * fresh read; tried again every 250 ms until 3.5 s after the click (the
   * write is idempotent; a stalled answer, 1 s without a byte, is cut); the
   * mode read back (off or rundown) confirms it. Answered by 4.3 s; still
   * running then, it goes on, bounded, and the answer says whether it was
   * sent yet. Kept afterwards (see the header).
   */
  async sendStop(received, target, { reassert = false } = {}) {
    this.protectSeq += 1;
    const previous = this.stopGuard?.unit === target.unit ? this.stopGuard : undefined;
    const sticky =
      this.startOpen ||
      this.guardActive('modeId') ||
      this.guardActive('power') ||
      Boolean(previous?.sticky);
    this.stopGuard = {
      ...target,
      sentAt: this.mono(),
      pending: true,
      // A press starts the count again; a resend keeps it.
      sent: reassert ? (previous?.sent ?? false) : false,
      seenOff: false,
      onReads: 0,
      reasserts: reassert ? (previous?.reasserts ?? 0) : 0,
      sticky,
    };
    const guard = this.stopGuard;
    // Kept before the first byte; /data is given a short moment, never awaited longer.
    await this.bounded(this.persistStopGuard(), TIMINGS.stopSaveWait).catch(() => {});
    const state = { written: false, counted: false, loginTried: false };
    const retryUntil = received + TIMINGS.commandSendBy;
    const count = () => {
      // Only a send that left counts (a "403" page, a refused connection, never).
      if (!state.written || state.counted) return;
      state.counted = true;
      if (guard.sent) guard.reasserts += 1;
      guard.sent = true;
      this.persistStopGuard().catch(() => {});
    };
    const attempt = async (line) => {
      const timeout = Math.max(250, Math.min(TIMINGS.requestTimeout, retryUntil - this.mono()));
      const options = { timeoutMs: timeout, idleMs: TIMINGS.stopIdle };
      // The sign-in: once per press, bounded by the stop's budget only (never
      // the 1 s cut of the write: a slow sign-in still takes a place on the unit).
      const signIn = Math.max(250, retryUntil - this.mono());
      try {
        const answer = await this.authed(
          line,
          (code) => writePath(code, STOP_WRITES, this.random),
          {
            ...options,
            loginOptions: { timeoutMs: signIn, idleMs: signIn },
            beforeSend: () => {
              state.written = true;
              this.lastSentAt = this.mono();
              this.startOpen = false;
            },
          },
          {
            login: !state.loginTried,
            onLogin: () => {
              state.loginTried = true;
            },
            notApplied: () => {
              state.written = false;
            },
          },
        );
        count();
        if (answer.status !== 200) {
          throw new AtreaError(
            answer.status >= 500 ? ERROR_KINDS.PROTOCOL : ERROR_KINDS.HTTP,
            'stop answered badly',
            { sent: true, status: answer.status },
          );
        }
      } catch (err) {
        count();
        throw err;
      }
      const { values } = await this.readStatus(line, options, { login: false });
      return values;
    };
    this.reserved += 1;
    const sending = (async () => {
      try {
        await this.takeLine(['read', 'command', 'protect']);
        for (;;) {
          try {
            return await this.useLine('protect', attempt, target);
          } catch (err) {
            const again =
              !this.closed &&
              STOP_AGAIN.has(err?.kind) &&
              this.mono() + TIMINGS.connectRetry < retryUntil;
            if (!again) {
              throw err;
            }
            await new Promise((resolve) => this.timers.setTimeout(resolve, TIMINGS.connectRetry));
          }
        }
      } finally {
        this.reserved -= 1;
      }
    })();
    this.logger.info(`Atrea: stop${sticky ? ' (after a mode or power not confirmed)' : ''}`);
    const answerIn = Math.max(0, received + TIMINGS.commandAnswerBy - this.mono());
    let late;
    const outcome = await new Promise((resolve) => {
      late = this.timers.setTimeout(() => resolve({ late: true }), answerIn);
      sending.then(
        (back) => resolve({ back }),
        (err) => resolve({ err }),
      );
    });
    this.timers.clearTimeout(late);
    const own = this.stopGuard === guard;
    // Off (or stopping) AND in the manual program, when the program is readable:
    // a unit that kept the weekly program would start again at its next slot.
    const stopped = (values) =>
      values &&
      STOPPED_MODES.has(values.modeId) &&
      (values.program === undefined || values.program === 'manual');
    if (stopped(outcome.back)) {
      if (own) {
        guard.pending = false;
        guard.seenOff = true;
        guard.onReads = 0;
        this.persistStopGuard().catch(() => {});
      }
      this.guards.delete('modeId');
      this.guards.delete('power');
      if (sticky) {
        this.followUp();
      }
      if (target.unit === this.unitKey()) {
        this.noteValues(outcome.back, { fromCommand: true });
      }
      this.logger.info('Atrea: stop confirmed by the unit');
      return;
    }
    this.followUp();
    if (outcome.late) {
      sending
        .then((back) => {
          if (stopped(back) && this.stopGuard === guard) {
            guard.pending = false;
            guard.seenOff = true;
            this.persistStopGuard().catch(() => {});
          }
        })
        .catch((err) => this.logger.warn(`Atrea: stop failed after the ack (${errorReason(err)})`));
      if (!state.written) {
        throw this.refusal(ERRORS.stopPending);
      }
      throw this.refusal(
        ERRORS.sentUnconfirmed(
          word(both('no answer yet', 'pas encore de réponse'), this.config.language),
        ),
      );
    }
    if (outcome.err) {
      const reason = errorReason(outcome.err);
      this.logger.warn(`Atrea: stop failed (${reason})`);
      if (!state.written) {
        if (outcome.err.kind === ERROR_KINDS.NO_LOGIN) throw this.refusal(ERRORS.stopHeld);
        if (outcome.err.kind === ERROR_KINDS.FORBIDDEN) throw this.refusal(ERRORS.stopNoSession);
        if (outcome.err.kind === ERROR_KINDS.DENIED) {
          throw this.refusal(this.refused ? ERRORS.stopHeld : ERRORS.stopDenied);
        }
        throw this.refusal(ERRORS.stopNotSent(reason));
      }
      throw this.refusal(ERRORS.sentUnconfirmed(reason));
    }
    if (outcome.back !== undefined && target.unit === this.unitKey()) {
      this.noteValues(outcome.back, { fromCommand: true });
    }
    const why =
      outcome.back?.running === false
        ? both('program not manual', 'programme non manuel')
        : both('still running', 'toujours en marche');
    throw this.refusal(ERRORS.sentUnconfirmed(word(why, this.config.language)));
  }

  /** The kept stop ends (a mode chosen, or the unit started elsewhere). */
  liftStopGuard(reason) {
    if (!this.stopGuard) return;
    this.logger.info(`Atrea: kept stop lifted (${reason})`);
    this.stopGuard = undefined;
    this.persistStopGuard().catch(() => {});
  }

  // --- Guards --------------------------------------------------------------------

  guardActive(key) {
    const guard = this.guards.get(key);
    if (guard && this.mono() >= guard.until) {
      this.guards.delete(key);
      return false;
    }
    return Boolean(guard);
  }

  /**
   * A read through the guards: a command guard lifts when the value moved
   * from the start state to the one asked (never on an unknown value). The
   * kept stop, on a poll of its own unit only (never a command's fresh read):
   * off read -> seen off; running read before it was seen off (or after a
   * mode or power that may still land) -> sent again, three sends at most;
   * running read twice in a row after it was seen off -> started elsewhere,
   * lifted. An unknown mode changes nothing but the count of "running" reads.
   */
  observe(values, { fromCommand = false } = {}) {
    for (const key of [...this.guards.keys()]) {
      if (!this.guardActive(key) || values[key] === undefined) {
        continue;
      }
      const guard = this.guards.get(key);
      if (values[key] !== guard.from) {
        guard.moved = true;
      }
      if (guard.moved && values[key] === guard.expected) {
        this.guards.delete(key);
      }
    }
    const stop = this.ownGuard();
    if (!stop || fromCommand) {
      return;
    }
    if (this.lastStartAt > stop.sentAt) {
      this.liftStopGuard('mode chosen after the stop');
      return;
    }
    const manual = values.program === undefined || values.program === 'manual';
    if (values.running === false && !manual) {
      // Off but still in another program: the stop is not applied (the program
      // would start the unit again at its next slot). Never "seen off".
      if (stop.onReads !== 0) {
        stop.onReads = 0;
        this.persistStopGuard().catch(() => {});
      }
      if (stop.seenOff) return;
    } else if (values.running === false) {
      if (!stop.seenOff || stop.onReads !== 0 || stop.pending) {
        stop.seenOff = true;
        stop.pending = false;
        stop.onReads = 0;
        this.persistStopGuard().catch(() => {});
      }
      return;
    } else if (values.running !== true) {
      if (stop.onReads !== 0) {
        stop.onReads = 0;
        this.persistStopGuard().catch(() => {});
      }
      return;
    }
    if (stop.seenOff && values.running === true) {
      stop.onReads += 1;
      if (stop.onReads >= 2) {
        this.liftStopGuard('unit read running twice in a row after the stop, started elsewhere');
        return;
      }
      this.persistStopGuard().catch(() => {});
      if (!stop.sticky) {
        return;
      }
    }
    if (
      this.protecting ||
      this.reassertTimer ||
      (stop.sent && stop.reasserts >= TIMINGS.stopReasserts)
    ) {
      return;
    }
    this.logger.warn('Atrea: the unit is still running after a stop, stop sent again');
    const generation = this.generation;
    this.reassertTimer = this.timers.setTimeout(() => {
      this.reassertTimer = undefined;
      if (generation !== this.generation || this.ownGuard() !== stop || this.closed) {
        return;
      }
      this.protect(this.mono(), this.guardTarget(stop), { reassert: true }).catch((err) =>
        this.logger.warn(`Atrea: stop sent again: ${err.message}`),
      );
    }, TIMINGS.reassertDelay);
  }

  /**
   * Spaced reads after a command: its effect, then a check. One series
   * pending at a time (a scene pressing in a loop never multiplies them).
   */
  followUp() {
    const generation = this.generation;
    const u = this.unit;
    for (const handle of u.followUps) {
      this.timers.clearTimeout(handle);
    }
    u.followUps.clear();
    if (this.closed) return;
    for (const delay of TIMINGS.followUps) {
      const handle = this.timers.setTimeout(() => {
        u.followUps.delete(handle);
        if (generation === this.generation) {
          Promise.resolve(u.running)
            .then(() => this.tick())
            .catch(() => this.logger.error('Atrea refresh failed'));
        }
      }, delay);
      u.followUps.add(handle);
    }
  }
}
