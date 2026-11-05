// -----------------------------------------------------------------------------
// The points of review r2, one test each: a sign-in that never left is tried
// again within the stop's budget; a sign-in cut after it left is never tried
// twice nor counted as a refusal; the same password saved again sends the kept
// stop at once; the status after a session that works; a unit off but still in
// the weekly program is never "seen off".
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MINUTE, SECOND } from '../src/constants.js';
import { memoryStore } from '../src/store.js';
import { HOST, PASSWORD, fakeAtrea } from './fixtures/fakeAtrea.js';
import { CFG, STOP_WRITES, setup } from './helpers/setup.js';

const writesOf = (ctx) => ctx.core.writes();
const loginsSent = (ctx) =>
  ctx.unit.raw.filter((r) => r.startsWith('GET /config/login.cgi')).length;

test('I1-r2: the sign-in connection refused right after the "403": tried again within the budget, the stop leaves', async (t) => {
  const ctx = await setup(t);
  ctx.core.sessions = [];
  ctx.unit.refuseAfter403 = 1;
  const before = loginsSent(ctx);
  const ack = await ctx.press('stop');
  assert.equal(ack.success, true, String(ack.error));
  assert.deepEqual(writesOf(ctx), [STOP_WRITES]);
  assert.equal(loginsSent(ctx) - before, 1, 'one sign-in sent');
});

test('I1-r2: a sign-in cut after it left: no second sign-in in the press, a readable answer', async (t) => {
  const ctx = await setup(t);
  ctx.core.sessions = [];
  ctx.unit.delays['/config/login.cgi'] = 6000;
  const before = loginsSent(ctx);
  const ack = await ctx.press('stop', 1, 8 * SECOND);
  assert.equal(ack.success, false);
  assert.equal(loginsSent(ctx) - before, 1);
  assert.doesNotMatch(String(ack.error), /forbidden/);
  assert.match(String(ack.error), /gardé/);
});

test('I2-r2 (K16): a read whose sign-in we cut took a place: the "denied" after it is not a refusal', async (t) => {
  const unit = fakeAtrea();
  unit.core.maxSessions = 1;
  unit.applyClosedLogins = true;
  const ctx = await setup(t, { unit, create: false, connect: false });
  unit.delays['/config/login.cgi'] = 8000; // the read cuts it (5 s without a byte)
  const connecting = ctx.gladys.connect();
  await ctx.advance(10 * SECOND, 100);
  await ctx.until(connecting, 'the connection');
  assert.equal(unit.core.sessions.length, 1, 'the unit opened the session we never saw');
  unit.delays['/config/login.cgi'] = 10;
  await ctx.advance(3 * MINUTE, 200);
  const denied = unit.core.log.filter((e) => e.path === '/config/login.cgi').length;
  assert.ok(denied >= 3, `${denied} sign-ins`);
  assert.equal(ctx.app.refused, false, 'the first denial after our cut is not counted');
});

test("I2-r2 (N7, m1'): the same password saved again sends the kept stop at once; the status drops the refusal", async (t) => {
  const store = memoryStore();
  const config = { ...CFG, poll_interval: 3600 };
  const ctx = await setup(t, { store, config });
  ctx.core.password = 'other-side';
  ctx.core.sessions = [];
  // Two reads denied (an hour apart): refused, the status says so.
  for (let i = 0; i < 4 && !ctx.app.refused; i += 1) await ctx.advance(3601 * SECOND, 1000);
  assert.equal(ctx.app.refused, true);
  const ack = await ctx.press('stop');
  assert.equal(ack.success, false);
  // The follow-up reads of the press are over; no read is due for an hour.
  await ctx.advance(30 * SECOND, 500);
  assert.equal(writesOf(ctx).length, 0);
  ctx.core.password = PASSWORD;
  await ctx.until(ctx.gladys.fake.configUpdated(config));
  await ctx.advance(2 * SECOND, 50);
  assert.deepEqual(writesOf(ctx), [STOP_WRITES]);
  assert.doesNotMatch(ctx.message(), /refusé le mot de passe|mal répondu/);
  assert.equal(ctx.status().connected, true, 'a session works: connected again');
});

test('I1-r2 (N1): a sign-in closed unanswered is never sent twice in a press; the answer says why', async (t) => {
  const ctx = await setup(t);
  ctx.core.sessions = [];
  ctx.unit.closeOn.add('/config/login.cgi');
  const before = loginsSent(ctx);
  const ack = await ctx.press('stop');
  assert.equal(ack.success, false);
  assert.equal(loginsSent(ctx) - before, 1, 'one sign-in per press');
  assert.match(String(ack.error), /connexion de cet appui a échoué/);
});

test('m5\': a unit off but still in the weekly program is never "seen off"; the stop is sent again', async (t) => {
  const unit = fakeAtrea();
  unit.core.registers.set('H10700', '1');
  const store = memoryStore();
  const ctx = await setup(t, { unit, store });
  ctx.core.ignoreProgram = true;
  const ack = await ctx.press('stop');
  assert.equal(ack.success, false);
  assert.match(String(ack.error), /programme non manuel/);
  await ctx.advance(MINUTE + 2 * SECOND, 100);
  assert.equal(store.data.stopGuard.seenOff, false);
  assert.equal(store.data.stopGuard.pending, true);
  assert.ok(writesOf(ctx).length >= 2, 'sent again');
  // The weekly slot starts the unit: the kept stop is not lifted.
  ctx.core.registers.set('H10705', '2');
  await ctx.advance(2 * (MINUTE + 2 * SECOND), 100);
  assert.ok(store.data.stopGuard, 'still kept');
  assert.equal(HOST, store.data.stopGuard.unit);
});
