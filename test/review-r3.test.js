// -----------------------------------------------------------------------------
// The points of review r3: one test per guard of milestone 1 whose mutant
// survived (the kept stop sent as soon as the configuration is read after a
// restart, strict flags, 300 states a minute, the unit ID gone or another
// one, a write answered 404, the status after a stop that signed in), and the
// answer of a stop whose sign-in failed. Every wait is bounded (mocked clock).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEVICE_TRANSPORTS } from '@gladysassistant/integration-sdk';
import { MINUTE, SECOND } from '../src/constants.js';
import { decodeStatus } from '../src/atrea/protocol.js';
import { StatePublisher } from '../src/publisher.js';
import { memoryStore } from '../src/store.js';
import { HOST, NOW, defaultRegisters, fakeAtrea } from './fixtures/fakeAtrea.js';
import { ALLOW, CFG, STOP_WRITES, setup } from './helpers/setup.js';

const writesOf = (ctx) => ctx.core.writes();
const ID_REGISTERS = [...Array(10)].map((_, i) => `H123${String(i).padStart(2, '0')}`);
const setId = (ctx, text) =>
  ID_REGISTERS.forEach((r, i) =>
    ctx.core.registers.set(r, String(i < text.length ? text.charCodeAt(i) : 0)),
  );
const badge = (ctx) => ctx.gladys.fake.transports.at(-1)?.transport;
/** One more poll (the interval is 60 s) and its states sent. */
const nextRead = (ctx) => ctx.advance(MINUTE + 2 * SECOND, 100);
/** The unit answers `status`/`body` for one path (logged as a request all the same). */
function answerOn(ctx, path, status, body) {
  const answer = ctx.core.answer;
  ctx.core.answer = (url) => {
    if (new URL(url, 'http://unit').pathname !== path) return answer(url);
    ctx.core.log.push({ path, url });
    return { status, body };
  };
}

// --- G23 ------------------------------------------------------------------------

test('I1-r3 (G23): a kept stop that never left, restart within the interval: sent once the configuration is read, before the first read', async (t) => {
  const store = memoryStore({
    // The last read 10 s before the restart: the first read waits a minute.
    lastAttemptAt: NOW - 10 * SECOND,
    target: { unit: HOST, host: HOST, port: 80 },
    stopGuard: { unit: HOST, host: HOST, port: 80, pending: true, sent: false },
  });
  const ctx = await setup(t, { store, boot: true, connect: false });
  // The resend at boot: the unit asks for a session and the password is not known yet.
  await ctx.advance(500, 50);
  assert.deepEqual(writesOf(ctx), []);
  const connecting = ctx.gladys.connect();
  await ctx.advance(2 * SECOND, 50);
  await ctx.until(connecting, 'the connection');
  assert.deepEqual(writesOf(ctx), [STOP_WRITES], 'sent at once, not at the first read');
  const firstWrite = ctx.core.log.findIndex((e) => e.writes);
  const firstRead = ctx.core.log.findIndex((e) => e.path === '/config/xml.xml');
  assert.ok(firstWrite < firstRead, 'the read back of the stop is the first read');
  assert.equal(store.data.stopGuard.pending, false);
  assert.match(ctx.message(), /Prochaine lecture/, 'the first poll still waits for the interval');
});

// --- G7 -------------------------------------------------------------------------

test('I1-r3 (G7): a flag (heating, cooling, filters) empty or other than 0/1 is unknown, never published 0', async (t) => {
  const map = defaultRegisters();
  for (const [register, key] of [
    ['C10215', 'heating'],
    ['C10216', 'cooling'],
    ['D11183', 'filter'],
  ]) {
    for (const bad of ['', ' 1', '01', '2', 'x', '1.0', 'true']) {
      map.set(register, bad);
      assert.equal(decodeStatus(map)[key], undefined, `${register} ${JSON.stringify(bad)}`);
    }
    map.set(register, '0');
    assert.equal(decodeStatus(map)[key], false);
    map.set(register, '1');
    assert.equal(decodeStatus(map)[key], true);
  }
  // Through the integration: the last value stays, never replaced by 0.
  const unit = fakeAtrea();
  unit.core.registers.set('C10215', '1');
  unit.core.registers.set('D11183', '1');
  const ctx = await setup(t, { unit });
  assert.equal(ctx.state('heating').state, 1);
  assert.equal(ctx.state('cooling').state, 1);
  assert.equal(ctx.state('filter-warning').state, 1);
  ctx.core.registers.set('C10215', '');
  ctx.core.registers.set('C10216', 'x');
  ctx.core.registers.set('D11183', '');
  ctx.core.registers.set('H10714', '77');
  await nextRead(ctx);
  assert.equal(ctx.state('fan-power').state, 77, 'the read was applied');
  assert.equal(ctx.state('heating').state, 1);
  assert.equal(ctx.state('cooling').state, 1);
  assert.equal(ctx.state('filter-warning').state, 1);
});

// --- G12 ------------------------------------------------------------------------

test('I1-r3 (G12): never more than 300 states a minute to Gladys (at once too); the rest after the minute', async () => {
  let now = 1_000_000;
  const batches = [];
  const publisher = new StatePublisher({
    gladys: {
      publishChangedStates: async (batch) => {
        batches.push(batch.length);
      },
    },
    logger: { warn() {} },
    now: () => now,
    timers: { setInterval() {}, clearInterval() {} },
  });
  const total = () => batches.reduce((a, b) => a + b, 0);
  for (let i = 0; i < 400; i += 1) publisher.push(`f${i}`, { state: i });
  for (let i = 0; i < 6; i += 1) await publisher.flush();
  assert.equal(total(), 300);
  assert.ok(
    batches.every((n) => n <= 100),
    'at most 100 a request',
  );
  now += 30 * SECOND;
  await Promise.all([publisher.flush(), publisher.flush(), publisher.flush()]);
  assert.equal(total(), 300, 'flushes at once share the budget');
  now += 30 * SECOND;
  await publisher.flush();
  assert.equal(total(), 400, 'the rest once the minute is over');
});

// --- G19, G20 -------------------------------------------------------------------

test('I1-r3 (G19): another unit at the address: the badge of the device is "unreachable", never "local"', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  assert.equal(badge(ctx), DEVICE_TRANSPORTS.LOCAL);
  setId(ctx, 'XYZ9876');
  await nextRead(ctx);
  assert.match(ctx.message(), /identifiant de la centrale a changé/);
  assert.equal(badge(ctx), DEVICE_TRANSPORTS.UNREACHABLE);
  setId(ctx, 'ATR1234');
  await nextRead(ctx);
  assert.equal(badge(ctx), DEVICE_TRANSPORTS.LOCAL, 'the unit learnt is back');
});

for (const [name, remove] of [
  ['missing', (ctx) => ID_REGISTERS.forEach((r) => ctx.core.registers.delete(r))],
  ['all 0', (ctx) => setId(ctx, '')],
]) {
  test(`I1-r3 (G20): the ID registers ${name} after the ID was learnt: unreadable, never another unit`, async (t) => {
    const ctx = await setup(t, { config: ALLOW });
    remove(ctx);
    ctx.core.registers.set('H10714', '77');
    await nextRead(ctx);
    assert.equal(ctx.app.mismatch, undefined);
    assert.equal(ctx.app.idUnreadable, true);
    assert.match(ctx.message(), /identifiant de la centrale est illisible/);
    assert.doesNotMatch(ctx.message(), /a changé/);
    assert.equal(ctx.state('fan-power').state, 77, 'the values still reach the device');
    assert.equal(badge(ctx), DEVICE_TRANSPORTS.LOCAL);
    let ack = await ctx.press('fan-power', 60);
    assert.equal(ack.success, false);
    assert.match(String(ack.error), /n’a pas pu être relu/);
    assert.equal(writesOf(ctx).length, 0);
    // The ID back: the commands work again (no acceptance needed).
    setId(ctx, 'ATR1234');
    ack = await ctx.press('fan-power', 60);
    assert.equal(ack.success, true, String(ack.error));
    assert.deepEqual(writesOf(ctx), [[['H10708', 60]]]);
  });
}

// --- G34 ------------------------------------------------------------------------

test('I1-r3 (G34): a write answered 404 is "refused by the unit, not applied", never "sent, without confirmation"', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  answerOn(ctx, '/config/xml.cgi', 404, 'HTTP: 404 Page');
  const ack = await ctx.press('fan-power', 60);
  assert.equal(ack.success, false);
  assert.match(String(ack.error), /La centrale a refusé la commande \(HTTP 404\) : non appliquée/);
  assert.doesNotMatch(String(ack.error), /sans confirmation/);
  assert.equal(ctx.app.guards.size, 0, 'no guard nor follow-up for a refused write');
});

test('I1-r3 (G34): a mode answered 404 under a kept stop: refused, the stop stays kept (memory and /data)', async (t) => {
  const store = memoryStore();
  const ctx = await setup(t, { store, config: ALLOW });
  assert.equal((await ctx.press('stop')).success, true);
  answerOn(ctx, '/config/xml.cgi', 404, 'HTTP: 404 Page');
  const ack = await ctx.press('mode', 'ventilation');
  assert.equal(ack.success, false);
  assert.match(String(ack.error), /La centrale a refusé la commande/);
  assert.equal(ctx.app.stopGuard?.unit, HOST);
  await ctx.advance(SECOND, 50);
  assert.equal(store.data.stopGuard?.unit, HOST);
});

// --- G38 ------------------------------------------------------------------------

test('I1-r3 (G38): after a stop that signed in, the status says neither "refused" nor "answered badly"', async (t) => {
  const unit = fakeAtrea();
  unit.core.maxSessions = 1;
  // Another user holds the only place: the first read is denied.
  unit.core.sessions = ['other-user'];
  const ctx = await setup(t, { unit, create: false });
  assert.equal(ctx.app.denials, 1);
  const ack = await ctx.press('stop');
  assert.equal(ack.success, false);
  assert.equal(ctx.app.refused, true);
  // The other user signs out; the configuration saved again: the stop leaves.
  ctx.core.sessions = [];
  await ctx.until(ctx.gladys.fake.configUpdated(CFG));
  await ctx.advance(2 * SECOND, 50);
  assert.deepEqual(writesOf(ctx), [STOP_WRITES]);
  assert.doesNotMatch(ctx.message(), /refusé le mot de passe|mal répondu/);
});

// --- m2-r3 ----------------------------------------------------------------------

test('m2-r3: a sign-in answered unreadable: the stop says the sign-in of the press failed', async (t) => {
  const ctx = await setup(t);
  ctx.core.sessions = [];
  answerOn(ctx, '/config/login.cgi', 200, '<?xml version="1.0"?><root>busy, try later</root>');
  const logins = ctx.core.logins();
  const ack = await ctx.press('stop');
  assert.equal(ack.success, false);
  assert.equal(ctx.core.logins() - logins, 1, 'one sign-in per press');
  assert.match(String(ack.error), /la connexion de cet appui a échoué/);
  assert.doesNotMatch(String(ack.error), /réponse à temps/);
});
