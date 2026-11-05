// -----------------------------------------------------------------------------
// The commands (mode, fan power) and "Stop the unit": options, guards,
// confirmation, the kept stop, every path the stop must never be held back on.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MINUTE, SECOND } from '../src/constants.js';
import { memoryStore } from '../src/store.js';
import { HOST, PASSWORD, fakeAtrea } from './fixtures/fakeAtrea.js';
import { ALLOW, CFG, DEVICE, STOP_WRITES, feature, flakyConfig, setup } from './helpers/setup.js';

const writesOf = (ctx) => ctx.core.writes();

test('the commands are refused while the option is off; nothing is sent', async (t) => {
  const ctx = await setup(t);
  for (const [role, value] of [
    ['mode', 'automatic'],
    ['fan-power', 60],
  ]) {
    const ack = await ctx.press(role, value);
    assert.equal(ack.success, false, role);
    assert.match(String(ack.error), /Autoriser les commandes/);
  }
  assert.deepEqual(writesOf(ctx), []);
});

test('a read-only feature or a bad value is refused unsent', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  for (const [role, value] of [
    ['temperature-supply', 1],
    ['mode', 'Automatic'],
    ['mode', ' automatic'],
    ['mode', 'off'],
    ['mode', 1],
    ['fan-power', 11],
    ['fan-power', 101],
    ['fan-power', 50.5],
    ['fan-power', ''],
    ['fan-power', '0x40'],
    ['stop', 0],
    ['stop', 'on'],
  ]) {
    const ack = await ctx.press(role, value, 200);
    assert.equal(ack.success, false, `${role} ${value}`);
  }
  assert.deepEqual(writesOf(ctx), []);
});

test('mode: decided on a fresh read, written, confirmed by the read back', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  const before = ctx.core.reads();
  const ack = await ctx.press('mode', 'automatic');
  assert.equal(ack.success, true, String(ack.error));
  assert.deepEqual(writesOf(ctx), [[['H10709', 1]]]);
  assert.equal(ctx.core.reads() - before, 2, 'fresh read, read back');
  assert.equal(ctx.state('mode').text, 'automatic');
  assert.equal(ctx.unit.maxOpen, 1);
});

test('mode under the weekly program: the program becomes temporary with it (pyatrea)', async (t) => {
  const unit = fakeAtrea();
  unit.core.registers.set('H10700', '1');
  const ctx = await setup(t, { config: ALLOW, unit });
  const ack = await ctx.press('mode', 'automatic');
  assert.equal(ack.success, true, String(ack.error));
  assert.deepEqual(writesOf(ctx), [
    [
      ['H10700', 2],
      ['H10701', 2],
      ['H10702', 2],
      ['H10709', 1],
    ],
  ]);
});

test('a mode the unit does not list as writable is refused unsent; unknown list too', async (t) => {
  const unit = fakeAtrea();
  unit.core.registers.set('H11700', '0');
  const ctx = await setup(t, { config: ALLOW, unit });
  let ack = await ctx.press('mode', 'circulation');
  assert.equal(ack.success, false);
  assert.match(String(ack.error), /ne permet pas/);
  unit.core.registers.delete('I12004');
  ack = await ctx.press('mode', 'automatic');
  assert.equal(ack.success, false);
  assert.match(String(ack.error), /liste des modes/);
  assert.deepEqual(writesOf(ctx), []);
});

test('mode already so: nothing sent', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  const ack = await ctx.press('mode', 'ventilation');
  assert.equal(ack.success, true);
  assert.deepEqual(writesOf(ctx), []);
});

test('fan power: bounded 12-100, written, confirmed; refused on a unit off', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  let ack = await ctx.press('fan-power', 75);
  assert.equal(ack.success, true, String(ack.error));
  assert.deepEqual(writesOf(ctx), [[['H10708', 75]]]);
  assert.equal(ctx.state('fan-power').state, 75);
  ack = await ctx.press('fan-power', '40');
  assert.equal(ack.success, true, String(ack.error));
  ctx.core.registers.set('H10705', '0');
  ack = await ctx.press('fan-power', 60);
  assert.equal(ack.success, false);
  assert.match(String(ack.error), /arrêtée ou en cours d’arrêt/);
  ctx.core.registers.set('H10705', '10');
  ack = await ctx.press('fan-power', 60);
  assert.equal(ack.success, false);
  assert.equal(writesOf(ctx).length, 2);
});

test('a write not applied: "not applied yet", a guard and spaced reads', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  ctx.core.ignoreWrites = true;
  const reads = ctx.core.reads();
  const ack = await ctx.press('fan-power', 80, 500);
  assert.equal(ack.success, false);
  assert.match(String(ack.error), /pas encore appliquée/);
  await ctx.advance(21 * SECOND, 100);
  assert.ok(ctx.core.reads() - reads >= 4, 'follow-up reads at 5 s and 20 s');
});

test('a write that never answers is "sent, without confirmation", never success nor "not sent"', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  ctx.unit.silent.add('/config/xml.cgi');
  const ack = await ctx.press('fan-power', 80);
  assert.equal(ack.success, false);
  assert.match(String(ack.error), /envoyée, sans confirmation/);
});

test('the unit unreachable for a command: "not sent"', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  ctx.unit.down = true;
  const ack = await ctx.press('fan-power', 80);
  assert.equal(ack.success, false);
  assert.match(String(ack.error), /non envoyée/);
});

test('a slow fresh read: refused unsent before 3.5 s, the ack before 5 s', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  ctx.unit.delays['/config/xml.xml'] = 3400;
  const started = Date.now();
  const ack = await ctx.press('fan-power', 80);
  assert.equal(ack.success, false);
  assert.match(String(ack.error), /non envoyée/);
  assert.ok(Date.now() - started <= 5 * SECOND);
  assert.deepEqual(writesOf(ctx), []);
});

test('the option turned off between the click and the write: not sent', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  ctx.unit.delays['/config/xml.xml'] = 300;
  const acking = ctx.fire('fan-power', 80);
  await ctx.advance(100);
  await ctx.until(ctx.gladys.fake.configUpdated(CFG));
  await ctx.advance(2 * SECOND, 50);
  const ack = await ctx.until(acking, 'the ack');
  assert.equal(ack.success, false);
  assert.deepEqual(writesOf(ctx), []);
});

test('a read begun before a command left is not applied', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  ctx.unit.delays['/config/xml.xml'] = 200;
  // A poll starts, then a command takes the line: the poll is dropped.
  await ctx.advance(MINUTE - 1200, 100);
  const statesBefore = ctx.gladys.fake.states.length;
  await ctx.advance(1150, 50);
  const ack = ctx.fire('fan-power', 90);
  await ctx.advance(5 * SECOND, 50);
  assert.equal((await ctx.until(ack, 'the ack')).success, true);
  const later = ctx.gladys.fake.states
    .slice(statesBefore)
    .filter((s) => s.device_feature_external_id === feature('fan-power'));
  assert.ok(later.every((s) => s.state === 90));
});

// --- The stop -------------------------------------------------------------------

test('stop: never held back by the option; manual program and mode off; confirmed; kept', async (t) => {
  const store = memoryStore();
  const ctx = await setup(t, { store });
  const ack = await ctx.press('stop');
  assert.equal(ack.success, true, String(ack.error));
  assert.deepEqual(writesOf(ctx), [STOP_WRITES]);
  assert.equal(ctx.state('running').state, 0);
  assert.equal(store.data.stopGuard.pending, false);
  assert.equal(store.data.stopGuard.sent, true);
  assert.equal(store.data.stopGuard.unit, HOST);
  await ctx.advance(MINUTE, 100);
  assert.match(ctx.message(), /arrêt envoyé depuis Gladys est gardé/i);
});

test('stop: a read stuck on a silent page never holds it back', async (t) => {
  const ctx = await setup(t);
  ctx.unit.silent.add('/config/xml.xml');
  await ctx.advance(MINUTE + 100, 100);
  ctx.unit.silent.delete('/config/xml.xml');
  const ack = await ctx.press('stop');
  assert.equal(ack.success, true, String(ack.error));
  assert.deepEqual(writesOf(ctx), [STOP_WRITES]);
});

test('stop: a stalled answer (1 s without a byte) is cut and the stop sent again in its window', async (t) => {
  const ctx = await setup(t);
  ctx.unit.stall.add('/config/xml.cgi');
  const acking = ctx.fire('stop');
  await ctx.advance(1500, 50);
  ctx.unit.stall.delete('/config/xml.cgi');
  await ctx.advance(3500, 50);
  const ack = await ctx.until(acking, 'the ack');
  assert.equal(ack.success, true, String(ack.error));
  assert.ok(writesOf(ctx).length >= 2);
});

test('stop: the session expired, one sign-in and the stop', async (t) => {
  const ctx = await setup(t);
  ctx.core.sessions = [];
  const ack = await ctx.press('stop');
  assert.equal(ack.success, true, String(ack.error));
  assert.deepEqual(writesOf(ctx), [STOP_WRITES]);
});

test('stop: a command in flight gives way; nothing emitted before the stop leaves after it', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  ctx.unit.delays['/config/xml.xml'] = 400;
  const command = ctx.fire('fan-power', 90);
  await ctx.advance(100);
  const stop = ctx.fire('stop');
  await ctx.advance(6 * SECOND, 50);
  assert.equal((await command).success, false);
  assert.equal((await stop).success, true);
  assert.deepEqual(writesOf(ctx), [STOP_WRITES]);
});

test('stop: unreachable, never sent, kept; leaves first when the unit answers; no send counted before', async (t) => {
  const store = memoryStore();
  const ctx = await setup(t, { store });
  ctx.unit.down = true;
  const ack = await ctx.press('stop');
  assert.equal(ack.success, false);
  assert.match(String(ack.error), /gardé et part en premier/);
  assert.equal(store.data.stopGuard.pending, true);
  assert.equal(store.data.stopGuard.sent, false);
  // Many reads fail: the stop is tried first at each, never given up, never counted.
  await ctx.advance(10 * MINUTE, 500);
  assert.equal(store.data.stopGuard.reasserts, 0);
  ctx.unit.down = false;
  const logBefore = ctx.core.log.length;
  await ctx.advance(6 * MINUTE, 500);
  const after = ctx.core.log.slice(logBefore).filter((e) => e.path !== '/config/login.cgi');
  assert.equal(after[0].path, '/config/xml.cgi', 'the stop first');
  assert.deepEqual(
    after[0].writes,
    STOP_WRITES.map(([r, v]) => [r, v]),
  );
  assert.equal(store.data.stopGuard.pending, false);
  assert.equal(ctx.state('running').state, 0);
});

test('stop: no password possible (refused twice) holds it; a new password sends it first', async (t) => {
  const unit = fakeAtrea();
  const store = memoryStore();
  const ctx = await setup(t, { unit, store });
  unit.core.password = 'changed';
  unit.core.sessions = [];
  await ctx.advance(2 * MINUTE + 500, 100);
  assert.match(ctx.message(), /deux fois de suite/);
  const ack = await ctx.press('stop');
  assert.equal(ack.success, false);
  assert.match(String(ack.error), /gardé et part en premier dès qu’un mot de passe/);
  assert.equal(writesOf(ctx).length, 0);
  assert.equal(store.data.stopGuard.sent, false);
  await ctx.advance(10 * MINUTE, 500);
  assert.equal(writesOf(ctx).length, 0, 'no sign-in on its own');
  await ctx.until(ctx.gladys.fake.configUpdated({ host: HOST, password: 'changed' }));
  await ctx.advance(2 * SECOND, 50);
  assert.deepEqual(writesOf(ctx), [STOP_WRITES], 'the stop first, at once');
  assert.equal(store.data.stopGuard.pending, false);
});

test('stop: /data that never answers holds back neither the stop nor the presses after it', async (t) => {
  const store = memoryStore();
  const ctx = await setup(t, { store });
  store.hang = true;
  for (let i = 0; i < 3; i += 1) {
    const ack = await ctx.press('stop', 1, 2 * SECOND);
    assert.equal(ack.success, true, String(ack.error));
  }
  assert.equal(writesOf(ctx).length, 3);
});

test('stop: /data failing never holds it back', async (t) => {
  const store = memoryStore();
  const ctx = await setup(t, { store });
  store.failSave = true;
  const ack = await ctx.press('stop');
  assert.equal(ack.success, true);
});

test('stop before the configuration is read: goes to the address kept in /data', async (t) => {
  const store = memoryStore({ target: { unit: HOST, host: HOST, port: 80 } });
  const getConfig = flakyConfig(Infinity);
  const ctx = await setup(t, { store, getConfig, create: false });
  ctx.core.requireAuth = false;
  const ack = await ctx.press('stop');
  assert.equal(ack.success, true, String(ack.error));
  assert.deepEqual(writesOf(ctx), [STOP_WRITES]);
});

test('boot: a stop that may not have landed is sent from /data before the configuration', async (t) => {
  const unit = fakeAtrea();
  unit.core.requireAuth = false;
  const store = memoryStore({
    stopGuard: { unit: HOST, host: HOST, port: 80, pending: true, sent: true },
  });
  const ctx = await setup(t, { unit, store, boot: true, connect: false });
  await ctx.advance(2 * SECOND, 50);
  assert.deepEqual(writesOf(ctx), [STOP_WRITES]);
  assert.equal(store.data.stopGuard.pending, false);
});

test('boot with a session needed: the kept stop leaves first once the configuration is read', async (t) => {
  const store = memoryStore({
    stopGuard: { unit: HOST, host: HOST, port: 80, pending: true, sent: false },
  });
  const ctx = await setup(t, { store, boot: true });
  await ctx.advance(2 * SECOND, 50);
  assert.deepEqual(writesOf(ctx), [STOP_WRITES]);
  const firstWrite = ctx.core.log.findIndex((e) => e.writes);
  const firstFullRead = ctx.core.log.findIndex(
    (e, i) =>
      e.path === '/config/xml.xml' && i > 0 && ctx.core.log[i - 1].path === '/config/xml.xml',
  );
  assert.ok(firstFullRead === -1 || firstWrite < firstFullRead);
  assert.equal(store.data.stopGuard.pending, false);
});

test('kept stop: the unit read running again is stopped again, three sends at most', async (t) => {
  const store = memoryStore();
  const ctx = await setup(t, { store });
  await ctx.press('stop');
  // The unit ignores the stop from now on, running.
  ctx.core.ignoreWrites = true;
  ctx.core.registers.set('H10705', '2');
  ctx.core.registers.set('H10709', '2');
  // Seen off by the read back, then read running: started elsewhere? It needs
  // two running reads in a row after being seen off; with a sticky stop it is sent again.
  await ctx.advance(MINUTE + 2 * SECOND, 100);
  await ctx.advance(MINUTE + 2 * SECOND, 100);
  assert.equal(store.data.stopGuard, null, 'read running twice after being seen off: lifted');
});

test('kept stop never confirmed: sent again by the reads that see the unit running, three at most', async (t) => {
  const store = memoryStore();
  const ctx = await setup(t, { store });
  ctx.core.ignoreWrites = true;
  const ack = await ctx.press('stop');
  assert.equal(ack.success, false);
  assert.match(String(ack.error), /sans confirmation/);
  for (let i = 0; i < 6; i += 1) await ctx.advance(MINUTE + 2 * SECOND, 100);
  assert.equal(writesOf(ctx).length, 4, 'the press and three resends');
  assert.equal(store.data.stopGuard.reasserts, 3);
  assert.match(ctx.message(), /ATTENTION/);
  // A new press starts the count again.
  await ctx.press('stop');
  assert.equal(writesOf(ctx).length, 5);
});

test('kept stop: the fan power is refused; a mode lifts it (saved before the write)', async (t) => {
  const store = memoryStore();
  const ctx = await setup(t, { store, config: ALLOW });
  await ctx.press('stop');
  let ack = await ctx.press('fan-power', 60);
  assert.equal(ack.success, false);
  assert.match(String(ack.error), /arrêt envoyé depuis Gladys est gardé|arrêtée/);
  let savedBeforeWrite;
  ctx.core.onWrite = () => {
    savedBeforeWrite = store.data.stopGuard;
  };
  ack = await ctx.press('mode', 'ventilation');
  assert.equal(ack.success, true, String(ack.error));
  assert.equal(savedBeforeWrite, null, '/data forgot the stop before the first byte');
  assert.equal(store.data.stopGuard, null);
});

test('kept stop: a mode with /data failing is refused unsent (the stop stays)', async (t) => {
  const store = memoryStore();
  const ctx = await setup(t, { store, config: ALLOW });
  await ctx.press('stop');
  store.failSave = true;
  const ack = await ctx.press('mode', 'ventilation');
  assert.equal(ack.success, false);
  assert.equal(writesOf(ctx).length, 1);
  assert.equal(ctx.app.stopGuard?.unit, HOST);
});

test('kept stop: never lifted by the time (a day of reads of a unit off)', async (t) => {
  const store = memoryStore();
  const ctx = await setup(t, { store, config: { ...CFG, poll_interval: 3600 } });
  await ctx.press('stop');
  for (let i = 0; i < 24; i += 1) await ctx.advance(61 * MINUTE, 10_000);
  assert.ok(store.data.stopGuard);
});

test('a scene pressing stop, then the power: the power is refused (stop kept), the stop left', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  const stop = ctx.fire('stop');
  const power = ctx.fire('fan-power', 90);
  await ctx.advance(6 * SECOND, 50);
  assert.equal((await stop).success, true);
  assert.equal((await power).success, false);
  assert.deepEqual(writesOf(ctx), [STOP_WRITES]);
});

test('the secret never reaches the logs, even on failures', async (t) => {
  const unit = fakeAtrea();
  unit.core.password = 'nope';
  const ctx = await setup(t, { unit, config: ALLOW });
  await ctx.press('stop');
  await ctx.press('mode', 'automatic');
  await ctx.advance(3 * MINUTE, 500);
  assert.ok(!JSON.stringify([ctx.logs, ctx.gladys.fake.connectionStatuses]).includes(PASSWORD));
});

test('the device of another unit: its features never command this one (refused on arrival, nothing read)', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  const other = 'ext:test-integration:atrea:id-zzz';
  const reads = ctx.core.reads();
  // Bounded (press): a command that went on would fail here, never hang the runner.
  const ack = await ctx.press('fan-power', 60, 200, other);
  assert.equal(ack.success, false);
  assert.match(String(ack.error), /identifiant de la centrale a changé/);
  assert.equal(writesOf(ctx).length, 0);
  assert.equal(ctx.core.reads(), reads, 'refused before any read of the unit');
  assert.ok(DEVICE);
});
