// -----------------------------------------------------------------------------
// The points of review r1, one test each (a mutant that breaks a fix fails
// here, never hangs): the stop with a slow sign-in, no busy loop without a
// read, the refusal lifted by a save, unit IDs with blanks, the guards of the
// stop path, and the minor points.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { MINUTE, SECOND } from '../src/constants.js';
import { ERROR_KINDS, httpGet } from '../src/atrea/http.js';
import { decodeStatus, parseLogin } from '../src/atrea/protocol.js';
import { memoryStore, passwordMark } from '../src/store.js';
import { HOST, NOW, PASSWORD, defaultRegisters, fakeAtrea } from './fixtures/fakeAtrea.js';
import { CFG, STOP_WRITES, setup } from './helpers/setup.js';

const writesOf = (ctx) => ctx.core.writes();

/** Counts the calls of app.run (a busy loop shows here). */
function countRuns(app) {
  const original = app.run.bind(app);
  const counter = { calls: 0 };
  app.run = () => {
    counter.calls += 1;
    return original();
  };
  return counter;
}

// --- B1 ---------------------------------------------------------------------------

test('B1: stop with an expired session and a sign-in answered in 1.2 s: one sign-in, the stop written', async (t) => {
  const unit = fakeAtrea();
  unit.core.maxSessions = 3;
  const ctx = await setup(t, { unit });
  ctx.core.sessions = [];
  const logins = ctx.core.logins();
  ctx.unit.delays['/config/login.cgi'] = 1200;
  const ack = await ctx.press('stop');
  assert.equal(ack.success, true, String(ack.error));
  assert.equal(ctx.core.logins() - logins, 1, 'one sign-in per press');
  assert.deepEqual(writesOf(ctx), [STOP_WRITES]);
  assert.equal(ctx.core.sessions.length, 1, 'one place taken on the unit');
});

test('B1: a sign-in slower than the stop budget is tried once per press, never repeated in the window', async (t) => {
  const unit = fakeAtrea();
  unit.core.maxSessions = 3;
  const ctx = await setup(t, { unit });
  ctx.core.sessions = [];
  const logins = ctx.core.logins();
  const sent = () => ctx.unit.raw.filter((r) => r.startsWith('GET /config/login.cgi')).length;
  const before = sent();
  ctx.unit.delays['/config/login.cgi'] = 6000;
  const ack = await ctx.press('stop', 1, 8 * SECOND);
  assert.equal(ack.success, false);
  assert.equal(sent() - before, 1, 'one sign-in sent per press');
  assert.equal(ctx.core.logins(), logins, 'the slow one was cut before its answer');
  assert.equal(ctx.app.refused, false);
});

test('B1: a "denied" right after a sign-in we cut never counts as a refusal', async (t) => {
  const ctx = await setup(t);
  ctx.app.loginCut = true;
  ctx.app.noteDenied();
  assert.equal(ctx.app.denials, 0);
  ctx.app.noteDenied();
  assert.equal(ctx.app.denials, 1);
});

// --- I1 ---------------------------------------------------------------------------

test('I1: a password over 64 bytes: no busy loop (the check waits for the interval)', async (t) => {
  const ctx = await setup(t, { config: { host: HOST, password: 'x'.repeat(65) }, create: false });
  const runs = countRuns(ctx.app);
  await ctx.advance(10 * MINUTE, 1000);
  assert.ok(runs.calls <= 12, `${runs.calls} runs in 10 min`);
  assert.equal(ctx.core.logins(), 0);
});

test('I1: refused by two stop presses after a good read: no busy loop', async (t) => {
  const ctx = await setup(t);
  ctx.core.password = 'changed';
  ctx.core.sessions = [];
  await ctx.press('stop');
  await ctx.press('stop');
  assert.equal(ctx.app.refused, true);
  const runs = countRuns(ctx.app);
  await ctx.advance(10 * MINUTE, 1000);
  assert.ok(runs.calls <= 12, `${runs.calls} runs in 10 min`);
});

test('I1: a restart with the refusal kept in /data: no busy loop', async (t) => {
  const salt = '0123456789abcdef';
  const store = memoryStore({ refused: { unit: HOST, salt, mark: passwordMark(salt, PASSWORD) } });
  const ctx = await setup(t, { store, create: false });
  const runs = countRuns(ctx.app);
  await ctx.advance(10 * MINUTE, 1000);
  assert.ok(runs.calls <= 12, `${runs.calls} runs in 10 min`);
});

// --- I2 ---------------------------------------------------------------------------

async function refusedWithKeptStop(t) {
  const store = memoryStore();
  const ctx = await setup(t, { store });
  ctx.core.password = 'other-side';
  ctx.core.sessions = [];
  await ctx.advance(2 * MINUTE + 500, 100);
  assert.equal(ctx.app.refused, true);
  const ack = await ctx.press('stop');
  assert.equal(ack.success, false);
  assert.equal(writesOf(ctx).length, 0);
  return { ctx, store };
}

test('I2: a new password with the same 6-bit mark as the refused one lifts the refusal; the kept stop goes first', async (t) => {
  const { ctx, store } = await refusedWithKeptStop(t);
  const { salt, mark } = store.data.refused;
  let collision;
  for (let i = 0; i < 10_000 && !collision; i += 1) {
    if (passwordMark(salt, `pw-${i}`) === mark) collision = `pw-${i}`;
  }
  assert.ok(collision);
  ctx.core.password = collision;
  await ctx.gladys.fake.configUpdated({ host: HOST, password: collision });
  await ctx.advance(2 * SECOND, 50);
  assert.equal(ctx.app.refused, false);
  assert.deepEqual(writesOf(ctx), [STOP_WRITES]);
});

test('I2: the same password saved again lifts the refusal for one try; the kept stop goes first', async (t) => {
  const { ctx } = await refusedWithKeptStop(t);
  // The other user signed out on the unit side (too many users was the cause).
  ctx.core.password = PASSWORD;
  await ctx.gladys.fake.configUpdated(CFG);
  await ctx.advance(2 * SECOND, 50);
  assert.deepEqual(writesOf(ctx), [STOP_WRITES]);
  assert.equal(ctx.app.refused, false);
});

test('I2: the same password saved again and still denied: refused again at once (one try)', async (t) => {
  const { ctx } = await refusedWithKeptStop(t);
  const logins = ctx.core.logins();
  await ctx.gladys.fake.configUpdated(CFG);
  await ctx.advance(5 * SECOND, 50);
  assert.equal(ctx.core.logins() - logins, 1);
  assert.equal(ctx.app.refused, true);
});

test('I2: a reconnection to Gladys never lifts the refusal', async (t) => {
  const { ctx } = await refusedWithKeptStop(t);
  const logins = ctx.core.logins();
  await ctx.app.connectedWith(async () => CFG);
  await ctx.advance(2 * SECOND, 50);
  assert.equal(ctx.core.logins(), logins);
  assert.equal(ctx.app.refused, true);
});

// --- I3 ---------------------------------------------------------------------------

const withId = (codes) => {
  const map = defaultRegisters();
  codes.forEach((c, i) => map.set(`H123${String(i).padStart(2, '0')}`, String(c)));
  return map;
};
const codesOf = (text) =>
  [...text]
    .map((c) => c.charCodeAt(0))
    .concat(Array(10).fill(0))
    .slice(0, 10);

test('I3: unit IDs: empty is no ID, trailing blanks removed, blanks inside kept; junk unreadable', () => {
  assert.equal(decodeStatus(withId(Array(10).fill(0))).id, null);
  assert.equal(decodeStatus(withId(codesOf('ATR1234   '))).id, 'ATR1234');
  assert.equal(decodeStatus(withId(codesOf('ECV 280'))).id, 'ECV 280');
  assert.equal(decodeStatus(withId(codesOf('          '))).id, null);
  assert.equal(decodeStatus(withId([65, 7, 0, 0, 0, 0, 0, 0, 0, 0])).idUnreadable, true);
  assert.equal(decodeStatus(withId([65, 200, 0, 0, 0, 0, 0, 0, 0, 0])).idUnreadable, true);
});

for (const [name, text, platform] of [
  ['an empty ID', '', 'unit'],
  ['an ID padded with blanks', 'ATR1234   ', 'id-atr1234'],
  ['an ID with a blank', 'ECV 280', 'id-ecv-280'],
]) {
  test(`I3: ${name} gives a device (and its stop button)`, async (t) => {
    const unit = fakeAtrea();
    codesOf(text).forEach((c, i) =>
      unit.core.registers.set(`H123${String(i).padStart(2, '0')}`, String(c)),
    );
    const ctx = await setup(t, { unit });
    const [device] = ctx.gladys.fake.discoveredDevices;
    assert.equal(device?.external_id, `ext:test-integration:atrea:${platform}`);
    assert.ok(device.features.some((f) => f.external_id.endsWith(':stop')));
  });
}

// --- I4 ---------------------------------------------------------------------------

test('I4 (K3): during a refusal, a stop press never signs in', async (t) => {
  const { ctx } = await refusedWithKeptStop(t);
  const logins = ctx.core.logins();
  await ctx.press('stop');
  await ctx.press('stop');
  assert.equal(ctx.core.logins(), logins);
});

test('I4 (K11): the kept stop survives ONE running read between two off reads', async (t) => {
  const store = memoryStore();
  const ctx = await setup(t, { store });
  await ctx.press('stop');
  await ctx.advance(30 * SECOND, 100);
  await ctx.advance(MINUTE, 100); // read off
  ctx.core.registers.set('H10705', '2');
  ctx.core.ignoreWrites = true;
  await ctx.advance(MINUTE, 100); // one running read (a resend may follow)
  ctx.core.registers.set('H10705', '0');
  await ctx.advance(MINUTE, 100); // off again
  assert.ok(store.data.stopGuard, 'still kept');
  assert.equal(store.data.stopGuard.onReads, 0);
});

test('I4 (K20): a stuck read is closed before the stop reaches the unit (one connection)', async (t) => {
  const ctx = await setup(t);
  ctx.unit.silent.add('/config/xml.xml');
  await ctx.advance(MINUTE + 100, 100);
  assert.equal(ctx.unit.open.size, 1, 'the stuck read');
  let openAtWrite;
  ctx.core.onWrite = () => {
    openAtWrite = ctx.unit.open.size;
  };
  ctx.unit.silent.delete('/config/xml.xml');
  const ack = await ctx.press('stop');
  assert.equal(ack.success, true, String(ack.error));
  assert.equal(openAtWrite, 1, 'only the stop connection was open');
  assert.equal(ctx.unit.maxOpen, 1);
});

// --- Minor points -------------------------------------------------------------

test('m1: the status says at once that a stop did not leave', async (t) => {
  const ctx = await setup(t);
  ctx.unit.down = true;
  await ctx.press('stop');
  assert.match(ctx.message(), /arrêt demandé dans Gladys n’a pas encore atteint/);
});

test('m2: right after a restart, the test button never reads sooner than the interval', async (t) => {
  // The time kept is up to a minute older than the true last read.
  const store = memoryStore({ lastAttemptAt: NOW - 50 * SECOND });
  const ctx = await setup(t, { store, config: { ...CFG, poll_interval: 30 } });
  const reads = ctx.core.reads();
  const pressing = ctx.gladys.fake.action('test_connection');
  await ctx.advance(200);
  await pressing;
  assert.equal(ctx.core.reads(), reads);
});

test('m3: the login answer is parsed in linear time (blanks, CR LF)', () => {
  for (const junk of [' '.repeat(4000), '\r\n'.repeat(2000), `<root>${' '.repeat(4000)}`]) {
    const started = performance.now();
    assert.equal(parseLogin(junk), undefined);
    assert.ok(performance.now() - started < 50, 'linear');
  }
  assert.deepEqual(parseLogin(`<?xml version="1.0"?>\r\n<root>\r\n 77 \r\n</root>\r\n`), {
    code: '77',
  });
});

test('m3: a chunked answer in tiny packets is read in linear time', async () => {
  const socket = new EventEmitter();
  socket.write = () => {};
  socket.destroy = () => {};
  const request = httpGet({
    host: '10.0.0.2',
    port: 80,
    path: '/x',
    connect: () => socket,
    timeoutMs: 60_000,
    maxBody: 4 * 1024 * 1024,
  });
  socket.emit('connect');
  socket.emit('data', Buffer.from('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n'));
  const started = performance.now();
  const piece = Buffer.from('a\r\n0123456789\r\n');
  for (let i = 0; i < 200_000; i += 1) socket.emit('data', piece);
  socket.emit('data', Buffer.from('0\r\n\r\n'));
  const { body } = await request.promise;
  assert.equal(body.length, 2_000_000);
  assert.ok(performance.now() - started < 3000, `${performance.now() - started} ms`);
  assert.ok(ERROR_KINDS.PROTOCOL);
});

test('m5: a unit that keeps the weekly program after the stop: not confirmed', async (t) => {
  const unit = fakeAtrea();
  unit.core.registers.set('H10700', '1');
  const ctx = await setup(t, { unit });
  ctx.core.ignoreProgram = true;
  const ack = await ctx.press('stop');
  assert.equal(ack.success, false);
  assert.match(String(ack.error), /sans confirmation/);
});

test('m6: a stop to the configured address never joins a resend to another address', async (t) => {
  const OLD = '10.0.0.9';
  const unit = fakeAtrea();
  unit.downHosts.add(OLD);
  const store = memoryStore({
    stopGuard: { unit: OLD, host: OLD, port: 80, pending: true, sent: false },
  });
  const ctx = await setup(t, { unit, store, boot: true, connect: false });
  const connecting = ctx.gladys.connect();
  await ctx.advance(300);
  const ack = ctx.fire('stop');
  await ctx.advance(10 * SECOND, 50);
  await connecting;
  assert.equal((await ack).success, true);
  assert.deepEqual(writesOf(ctx).at(-1), STOP_WRITES);
});
