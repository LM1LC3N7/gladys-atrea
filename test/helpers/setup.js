// -----------------------------------------------------------------------------
// The integration against the SDK's fake Gladys and a fake Atrea unit, with
// the exact wiring of the container (src/handlers.js) and a mocked clock. The
// monotonic clock follows the mocked Date and moves 1 µs at every read (a
// decision that reads it twice sees it move).
// -----------------------------------------------------------------------------

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { AtreaApp } from '../../src/app.js';
import { SECOND } from '../../src/constants.js';
import { registerHandlers } from '../../src/handlers.js';
import { memoryStore } from '../../src/store.js';
import { HOST, NOW, PASSWORD, fakeAtrea, settle } from '../fixtures/fakeAtrea.js';

export const CFG = { host: HOST, password: PASSWORD };
export const ALLOW = { ...CFG, allow_commands: true };
export const DEVICE = 'ext:test-integration:atrea:id-atr1234';
export const feature = (role, device = DEVICE) => `${device}:${role}`;
export const STOP_WRITES = [
  ['H10700', 0],
  ['H10701', 0],
  ['H10702', 0],
  ['H10703', 0],
  ['H10709', 0],
];

/**
 * A getConfig() that answers the SDK's own resynchronization (the first call,
 * made by connect() before 'connected'), then fails `fails` times (Infinity:
 * always) in the integration's handler.
 */
export function flakyConfig(fails, config = CFG) {
  let calls = 0;
  let left = fails;
  const fn = async () => {
    calls += 1;
    if (calls > 1 && left > 0) {
      left -= 1;
      throw new Error('Gladys busy');
    }
    return config;
  };
  fn.calls = () => calls;
  return fn;
}

export async function setup(
  t,
  {
    config = CFG,
    unit = fakeAtrea(),
    store = memoryStore(),
    create = true,
    getConfig,
    boot = false,
    connect = true,
  } = {},
) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: NOW });
  const gladys = createFakeGladys({ config });
  if (getConfig) gladys.getConfig = getConfig;
  const logs = [];
  const logger = Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((l) => [
      l,
      (...a) => logs.push(`${l}: ${a.map((x) => (x instanceof Error ? x.message : x)).join(' ')}`),
    ]),
  );
  let drift = 0;
  const app = new AtreaApp({
    gladys,
    logger,
    connect: unit.connectFn,
    now: () => Date.now(),
    clock: () => Date.now() + (drift += 0.001),
    store,
  });
  registerHandlers(gladys, app, logger);
  const advance = async (ms, step = 10) => {
    for (let e = 0; e < ms; e += step) {
      t.mock.timers.tick(Math.min(step, ms - e));
      await settle(3);
    }
  };
  t.after(() => app.stop({ shutdown: true }));
  if (boot) {
    await app.boot();
    await settle();
  }
  if (connect) {
    let connected = false;
    const connecting = gladys.connect().finally(() => {
      connected = true;
    });
    await settle();
    // Bounded: a start that never ends fails the test, never hangs it.
    for (let i = 0; i < 100 && !connected; i += 1) await advance(100);
    if (!connected) throw new Error('the start never ended');
    await connecting;
    if (create && gladys.fake.discoveredDevices.length > 0) {
      await gladys.fake.deviceCreated(gladys.fake.discoveredDevices[0]);
      await settle();
      await advance(1100);
    }
  }
  const fire = (role, value = 1, device = DEVICE) => {
    const d = gladys.fake.devices.find((x) => x.external_id === device) ?? { external_id: device };
    return gladys.fake.setValue(d, { external_id: feature(role, device) }, value);
  };
  // Bounded: a promise that never settles (on the mocked clock) fails the
  // test after `max` of mocked time, it never holds the runner.
  const until = async (promise, what = 'the promise', max = 10 * SECOND) => {
    let settled = false;
    promise.then(
      () => (settled = true),
      () => (settled = true),
    );
    // Given a chance first without moving the clock.
    await settle();
    for (let e = 0; e < max && !settled; e += 100) await advance(100, 50);
    if (!settled) throw new Error(`${what} never settled`);
    return promise;
  };
  // Bounded: an ack that never comes fails the test, never hangs it.
  const press = async (role, value = 1, wait = 5 * SECOND, device = DEVICE) => {
    const ack = fire(role, value, device);
    await advance(wait, 50);
    return until(ack, 'the ack', 5 * SECOND);
  };
  const state = (role) =>
    gladys.fake.states.findLast((s) => s.device_feature_external_id === feature(role));
  const status = () => gladys.fake.connectionStatus;
  const message = () => status()?.message?.fr ?? '';
  return {
    gladys,
    app,
    unit,
    core: unit.core,
    advance,
    logs,
    fire,
    press,
    until,
    store,
    state,
    status,
    message,
  };
}
