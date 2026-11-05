// -----------------------------------------------------------------------------
// The integration end to end: discovery, values, the session, the reads.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEVICE_TRANSPORTS } from '@gladysassistant/integration-sdk';
import { MINUTE, SECOND } from '../src/constants.js';
import { memoryStore, passwordMark } from '../src/store.js';
import { HOST, PASSWORD, fakeAtrea } from './fixtures/fakeAtrea.js';
import { CFG, DEVICE, feature, flakyConfig, setup } from './helpers/setup.js';

test('discovery: one device keyed by the unit ID, every value read and published, the exact requests', async (t) => {
  const ctx = await setup(t);
  const [device] = ctx.gladys.fake.discoveredDevices;
  assert.equal(device.external_id, DEVICE);
  assert.equal(device.model, 'Atrea RD5');
  assert.deepEqual(
    device.params.map((p) => p.name),
    ['protocol', 'unit_id', 'firmware'],
  );
  assert.equal(device.params[2].value, '2.1.32');
  const types = device.features.map((f) => `${f.category}/${f.type}`);
  assert.ok(!types.some((x) => x.startsWith('switch/')), 'never a switch');
  for (const f of device.features.filter((f) => !f.read_only)) {
    assert.ok(
      ['button/push', 'text/select', 'fan/percent'].includes(`${f.category}/${f.type}`),
      `${f.external_id} is writable`,
    );
    assert.notEqual(f.type, 'binary');
  }
  assert.equal(ctx.state('temperature-outdoor').state, -5.2, 'signed register');
  assert.equal(ctx.state('temperature-supply').state, 18.5);
  assert.equal(ctx.state('temperature-extract').state, 21.4);
  assert.equal(ctx.state('temperature-exhaust').state, 1.2);
  assert.equal(ctx.state('temperature-indoor').state, 22);
  assert.equal(ctx.state('temperature-outdoor-average').state, 3);
  assert.equal(ctx.state('temperature-requested').state, 21);
  assert.equal(ctx.state('fan-power').state, 50);
  assert.equal(ctx.state('fan-power-current').state, 50);
  assert.equal(ctx.state('running').state, 1);
  assert.equal(ctx.state('heating').state, 0);
  assert.equal(ctx.state('cooling').state, 1);
  assert.equal(ctx.state('filter-warning').state, 0);
  assert.equal(ctx.state('alert-count').state, 0);
  assert.equal(ctx.state('warning-count').state, 0);
  assert.equal(ctx.state('alarm-codes').text, 'none');
  assert.equal(ctx.state('mode').text, 'ventilation');
  assert.equal(ctx.state('current-mode').text, 'ventilation');
  assert.equal(ctx.state('program').text, 'manual');
  assert.equal(ctx.status().connected, true);
  assert.match(ctx.message(), /Atrea ATR1234 : ventilation 50 %/);
  const badge = ctx.gladys.fake.transports.at(-1);
  assert.equal(badge.device_external_id ?? badge.external_id, DEVICE);
  assert.equal(badge.transport, DEVICE_TRANSPORTS.LOCAL);
  // The registers page refused (no session), one sign-in, the page again, the metadata page.
  assert.deepEqual(
    ctx.core.log.slice(0, 4).map((e) => e.path),
    ['/config/xml.xml', '/config/login.cgi', '/config/xml.xml', '/user/params.xml'],
  );
  assert.equal(ctx.core.logins(), 1);
  assert.equal(ctx.unit.maxOpen, 1, 'one connection at a time');
  assert.equal(ctx.unit.open.size, 0, 'closed after');
  // Every request: HTTP/1.0, no User-Agent, the session code and two letters.
  for (const raw of ctx.unit.raw) {
    assert.match(raw, /^GET \/[^ ]+ HTTP\/1\.0\r\nHost: 192\.168\.1\.90\r\n/);
    assert.doesNotMatch(raw, /user-agent/i);
  }
  assert.match(ctx.core.log[2].url, /^\/config\/xml\.xml\?auth=5001&[A-Za-z]{2}$/);
  assert.deepEqual(ctx.store.data.identity, { unit: HOST, id: 'ATR1234', platform: 'id-atr1234' });
});

test('the password never shows: not in the logs, /data, the statuses, nor any request but the sign-in key', async (t) => {
  const ctx = await setup(t);
  await ctx.advance(MINUTE + 500, 100);
  const everything = JSON.stringify([
    ctx.logs,
    ctx.store.data,
    ctx.gladys.fake.connectionStatus,
    ctx.gladys.fake.states,
    ctx.gladys.fake.discoveredDevices,
  ]);
  assert.ok(!everything.includes(PASSWORD));
  assert.ok(!everything.includes('5001'), 'nor the session code');
  assert.ok(ctx.unit.raw.every((r) => !r.includes(PASSWORD)));
});

test('reads every interval, one sign-in kept (the session is reused)', async (t) => {
  const ctx = await setup(t);
  const reads = ctx.core.reads();
  await ctx.advance(3 * MINUTE + 500, 100);
  assert.equal(ctx.core.reads() - reads, 3);
  assert.equal(ctx.core.logins(), 1);
  assert.equal(ctx.core.log.filter((e) => e.path === '/user/params.xml').length, 1, 'hourly');
});

test('the session expired: one sign-in, then the page again; never two sessions at once', async (t) => {
  const ctx = await setup(t);
  ctx.core.sessions = [];
  await ctx.advance(MINUTE + 500, 100);
  assert.equal(ctx.core.logins(), 2);
  assert.equal(ctx.status().connected, true);
  assert.equal(ctx.unit.maxOpen, 1);
});

test('no password while the unit asks for one: clear status, no sign-in', async (t) => {
  const ctx = await setup(t, { config: { host: HOST } });
  assert.equal(ctx.core.logins(), 0);
  assert.equal(ctx.status().connected, false);
  assert.match(ctx.message(), /demande son mot de passe/);
});

test('a unit without sign-in: read without any password', async (t) => {
  const unit = fakeAtrea();
  unit.core.requireAuth = false;
  const ctx = await setup(t, { unit, config: { host: HOST } });
  assert.equal(ctx.core.logins(), 0);
  assert.equal(ctx.state('fan-power').state, 50);
});

test('the password denied once: tried again at the next read; twice: refused, kept in /data, no try on its own', async (t) => {
  const unit = fakeAtrea();
  unit.core.password = 'other';
  const store = memoryStore();
  const ctx = await setup(t, { unit, store });
  assert.equal(ctx.core.logins(), 1);
  assert.match(ctx.message(), /a refusé le mot de passe \(mauvais/);
  await ctx.advance(MINUTE + 500, 100);
  assert.equal(ctx.core.logins(), 2);
  assert.match(ctx.message(), /deux fois de suite/);
  const kept = store.data.refused;
  assert.equal(kept.unit, HOST);
  assert.equal(passwordMark(kept.salt, PASSWORD), kept.mark);
  assert.ok(!JSON.stringify(store.data).includes(PASSWORD));
  const requests = ctx.core.log.length;
  await ctx.advance(10 * MINUTE, 500);
  assert.equal(ctx.core.log.length, requests, 'nothing sent on its own');
  // The test button: one sign-in per press.
  const pressing = ctx.gladys.fake.action('test_connection');
  await ctx.advance(500);
  const result = await ctx.until(pressing, 'the test button');
  assert.equal(ctx.core.logins(), 3);
  assert.ok(result);
  assert.match(ctx.message(), /deux fois de suite/);
  // The right password on the unit side, and a press: works again.
  ctx.core.password = PASSWORD;
  await ctx.advance(MINUTE + 500, 100);
  assert.equal(ctx.core.logins(), 3, 'still nothing on its own');
  const pressed = ctx.gladys.fake.action('test_connection');
  await ctx.advance(500);
  await ctx.until(pressed, 'the test button');
  assert.equal(ctx.core.logins(), 4);
  assert.equal(ctx.status().connected, true);
  assert.equal(store.data.refused, null, 'lifted at the success');
});

test('a refusal kept in /data survives a restart with the same password, not a new one', async (t) => {
  const salt = '0123456789abcdef';
  const store = memoryStore({
    refused: { unit: HOST, salt, mark: passwordMark(salt, PASSWORD) },
  });
  const ctx = await setup(t, { store });
  assert.equal(ctx.core.logins(), 0);
  assert.match(ctx.message(), /deux fois de suite/);
  await ctx.until(ctx.gladys.fake.configUpdated({ ...CFG, password: 'new-one' }));
  await ctx.advance(MINUTE + 500, 100);
  assert.ok(ctx.core.logins() >= 1, 'a new password is tried');
});

test('the 6-bit fingerprint never tells the password: many candidates share it', () => {
  const salt = 'fedcba9876543210';
  const mark = passwordMark(salt, PASSWORD);
  let same = 0;
  for (let i = 0; i < 2000; i += 1) {
    if (passwordMark(salt, `guess-${i}`) === mark) same += 1;
  }
  assert.ok(same >= 10, `${same} of 2000 guesses share it`);
});

test('the metadata page failing never costs the values (secondary, spaced, no sign-in)', async (t) => {
  const unit = fakeAtrea();
  unit.core.paramsStatus = 500;
  const ctx = await setup(t, { unit });
  assert.equal(ctx.state('fan-power').state, 50);
  assert.equal(ctx.state('alarm-codes'), undefined, 'unknown, never "none" nor 0');
  assert.equal(ctx.state('alert-count'), undefined);
  assert.equal(ctx.status().connected, true);
  unit.core.paramsStatus = 200;
  unit.core.registers.set('D11183', '1');
  unit.core.registers.set('D11180', '1');
  await ctx.advance(2 * MINUTE + 500, 100);
  assert.equal(ctx.state('alarm-codes').text, 'D11180, D11183');
  assert.equal(ctx.state('alert-count').state, 1);
  assert.equal(ctx.state('warning-count').state, 1);
  assert.equal(ctx.state('filter-warning').state, 1);
});

test('the metadata page closing the connection keeps the values read before', async (t) => {
  const unit = fakeAtrea();
  unit.closeOn.add('/user/params.xml');
  const ctx = await setup(t, { unit });
  assert.equal(ctx.state('fan-power').state, 50);
  assert.equal(ctx.status().connected, true);
});

test('values outside their bounds, empty or text are never published as measures', async (t) => {
  const unit = fakeAtrea();
  unit.core.registers.set('I10212', '');
  unit.core.registers.set('I10213', 'abc');
  unit.core.registers.set('I10214', '3000');
  unit.core.registers.set('H10714', '101');
  unit.core.registers.set('H10706', '50');
  const ctx = await setup(t, { unit });
  for (const role of [
    'temperature-supply',
    'temperature-extract',
    'temperature-exhaust',
    'fan-power',
    'temperature-requested',
  ]) {
    assert.equal(ctx.state(role), undefined, role);
  }
  assert.equal(ctx.state('temperature-outdoor').state, -5.2);
});

test('an oversized answer is cut before it is read whole', async (t) => {
  const unit = fakeAtrea();
  unit.big.add('/config/xml.xml');
  const ctx = await setup(t, { unit });
  assert.equal(ctx.status().connected, false);
  assert.match(ctx.message(), /protocol/);
});

test('a restart never reads sooner than the interval (time kept in /data before the read)', async (t) => {
  const store = memoryStore({ lastAttemptAt: Date.UTC(2026, 10, 5, 9, 59, 50) });
  const ctx = await setup(t, { store, config: { ...CFG, poll_interval: 60 } });
  assert.equal(ctx.core.reads(), 0);
  assert.match(ctx.message(), /Prochaine lecture/);
  await ctx.advance(2 * MINUTE, 100);
  assert.ok(ctx.core.reads() >= 1);
});

test('the test button and a scan never read sooner than the interval', async (t) => {
  const ctx = await setup(t);
  const reads = ctx.core.reads();
  const pressing = ctx.gladys.fake.action('test_connection');
  await ctx.advance(200);
  const result = await ctx.until(pressing, 'the test button');
  assert.match(JSON.stringify(result), /Prochaine lecture|Next read/);
  await ctx.until(ctx.gladys.fake.scanRequest());
  await ctx.advance(500);
  assert.equal(ctx.core.reads(), reads);
});

test('getConfig() failing in `connected` is tried again, spaced, without end, then starts', async (t) => {
  const getConfig = flakyConfig(2);
  const ctx = await setup(t, { getConfig, create: false });
  assert.equal(ctx.core.reads(), 0);
  assert.match(ctx.message(), /configuration n’a pas pu être lue/);
  await ctx.advance(5 * SECOND + 100, 100);
  assert.equal(ctx.core.reads(), 0);
  await ctx.advance(16 * SECOND, 100);
  assert.ok(ctx.core.reads() >= 1);
  assert.equal(ctx.status().connected, true);
});

test('a reconnection to Gladys never reads the unit again sooner', async (t) => {
  const ctx = await setup(t);
  const reads = ctx.core.reads();
  await ctx.until(ctx.app.connectedWith(async () => CFG));
  await ctx.advance(500);
  assert.equal(ctx.core.reads(), reads);
  assert.equal(ctx.status().connected, true);
});

test('unreachable: badge unreachable, spaced tries, never "Connected"', async (t) => {
  const ctx = await setup(t);
  ctx.unit.down = true;
  await ctx.advance(MINUTE + 500, 100);
  assert.equal(ctx.status().connected, false);
  assert.match(ctx.message(), /Pas de réponse de 192\.168\.1\.90/);
  assert.equal(ctx.gladys.fake.transports.at(-1).transport, DEVICE_TRANSPORTS.UNREACHABLE);
});

test('another unit at the address: values not published to the old device, commands refused, test accepts it as a new device', async (t) => {
  const ctx = await setup(t, { config: { ...CFG, allow_commands: true } });
  for (let i = 0; i < 7; i += 1) {
    ctx.core.registers.set(`H123${String(i).padStart(2, '0')}`, String('XYZ9876'.charCodeAt(i)));
  }
  ctx.core.registers.set('H10714', '77');
  await ctx.advance(MINUTE + 500, 100);
  assert.match(ctx.message(), /identifiant de la centrale a changé \(ATR1234 → XYZ9876\)/);
  assert.equal(ctx.state('fan-power').state, 50, 'never written to the old device');
  const ack = await ctx.press('mode', 'automatic');
  assert.equal(ack.success, false);
  assert.match(String(ack.error), /identifiant/);
  assert.equal(ctx.core.writes().length, 0);
  const pressed = ctx.gladys.fake.action('test_connection');
  await ctx.advance(500);
  await ctx.until(pressed, 'the test button');
  assert.ok(
    ctx.gladys.fake.discoveredDevices.some(
      (d) => d.external_id === 'ext:test-integration:atrea:id-xyz9876',
    ),
  );
});

test('an unreadable unit ID is never another unit; commands refused', async (t) => {
  const ctx = await setup(t, { config: { ...CFG, allow_commands: true } });
  ctx.core.registers.set('H12300', 'x');
  await ctx.advance(MINUTE + 500, 100);
  assert.match(ctx.message(), /identifiant de la centrale est illisible/);
  const ack = await ctx.press('fan-power', 60);
  assert.equal(ack.success, false);
  assert.equal(ctx.core.writes().length, 0);
});

test('a unit without ID registers: device "unit", kept', async (t) => {
  const unit = fakeAtrea();
  for (let i = 0; i < 10; i += 1) unit.core.registers.delete(`H123${String(i).padStart(2, '0')}`);
  const ctx = await setup(t, { unit });
  assert.equal(ctx.gladys.fake.discoveredDevices[0].external_id, 'ext:test-integration:atrea:unit');
  assert.equal(ctx.store.data.identity.platform, 'unit');
});

test('/data unreadable: nothing written over it, commands refused, values still shown', async (t) => {
  const store = memoryStore({ lastAttemptAt: 1 });
  store.failLoad = true;
  const ctx = await setup(t, { store, config: { ...CFG, allow_commands: true } });
  assert.equal(store.saves, 0);
  assert.match(ctx.message(), /\/data illisible/);
  assert.equal(ctx.state('fan-power').state, 50);
  const ack = await ctx.press('fan-power', 60);
  assert.equal(ack.success, false);
  assert.match(String(ack.error), /\/data/);
  assert.equal(store.saves, 0);
});

test('/data that never answers a load is unreadable, never blocking', async (t) => {
  const store = memoryStore();
  store.hangLoad = true;
  const ctx = await setup(t, { store });
  await ctx.advance(2 * SECOND, 100);
  assert.match(ctx.message(), /\/data illisible/);
});

test('a configuration saved unchanged neither restarts nor reads', async (t) => {
  const ctx = await setup(t);
  const reads = ctx.core.reads();
  await ctx.until(ctx.gladys.fake.configUpdated(CFG));
  await ctx.advance(500);
  assert.equal(ctx.core.reads(), reads);
  assert.equal(ctx.status().connected, true);
});

test('stop() leaves no timer: nothing is sent after it', async (t) => {
  const ctx = await setup(t);
  ctx.app.stop({ shutdown: true });
  const count = ctx.core.log.length;
  await ctx.advance(10 * MINUTE, 1000);
  assert.equal(ctx.core.log.length, count);
});

test('the feature external ids of the device stay those of the frozen rule', async (t) => {
  const ctx = await setup(t);
  const ids = ctx.gladys.fake.discoveredDevices[0].features.map((f) => f.external_id);
  assert.ok(ids.includes(feature('stop')));
  assert.ok(ids.includes(feature('mode')));
  assert.ok(ids.includes(feature('fan-power')));
});
