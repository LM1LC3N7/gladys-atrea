// -----------------------------------------------------------------------------
// The integration on the real clock sped up 20 times, against a real HTTP
// server on 127.0.0.1 (gladys-testkit) that answers as the fake unit, with
// /data in a real temporary directory. The polling period is measured (start
// to start), the stop goes over a real socket, and the state file is the real
// one. Every wait is bounded and the app is stopped in `t.after`.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { httpServer, measurePeriod, realClock, reply, spyOn } from './kit/index.mjs';
import { AtreaApp } from '../src/app.js';
import { registerHandlers } from '../src/handlers.js';
import { fileStore } from '../src/store.js';
import { PASSWORD, atreaCore } from './fixtures/fakeAtrea.js';

const quiet = { debug() {}, info() {}, warn() {}, error() {} };

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'atrea-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const within = (promise, ms, what) =>
  Promise.race([
    promise,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`${what}: no end in ${ms} ms`)), ms);
      timer.unref();
    }),
  ]);

test('real clock x20: the period is the interval, start to start; the stop over a real socket', async (t) => {
  const core = atreaCore();
  const route = (request) => {
    const { status, body } = core.answer(request.url);
    return reply(status, body);
  };
  const server = await httpServer({
    latencyMs: 2,
    routes: {
      '/config/login.cgi': route,
      '/config/xml.xml': route,
      '/user/params.xml': route,
      '/config/xml.cgi': route,
    },
  });
  t.after(() => server.close());
  const dir = await tempDir(t);
  const clock = realClock({ speed: 20 });
  t.after(() => clock.close());
  const config = { host: `127.0.0.1:${server.port}`, password: PASSWORD, poll_interval: 30 };
  const gladys = createFakeGladys({ config });
  const app = new AtreaApp({
    gladys,
    logger: quiet,
    now: clock.now,
    clock: clock.monotonic,
    timers: clock.timers,
    store: fileStore(join(dir, 'state.json')),
  });
  t.after(() => app.stop({ shutdown: true }));
  registerHandlers(gladys, app, quiet);
  const spy = spyOn(app, 'run', clock);
  await within(app.boot(), 5000, 'boot');
  await within(gladys.connect(), 10_000, 'connect');
  const gaps = await within(measurePeriod(spy, { count: 4, period: 30_000 }), 30_000, 'period');
  assert.equal(gaps.length, 3);
  assert.equal(core.logins(), 1, 'one session kept');
  // The stop, over the real socket.
  const ack = await within(
    gladys.fake.setValue(
      { external_id: 'ext:test-integration:atrea:id-atr1234' },
      { external_id: 'ext:test-integration:atrea:id-atr1234:stop' },
      1,
    ),
    10_000,
    'stop',
  );
  assert.equal(ack.success, true, String(ack.error));
  assert.equal(core.registers.get('H10709'), '0');
  assert.equal(core.registers.get('H10700'), '0');
  let kept;
  for (let i = 0; i < 50; i += 1) {
    kept = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'));
    if (kept.stopGuard?.pending === false) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(kept.stopGuard.pending, false);
  assert.equal(kept.stopGuard.port, server.port);
  assert.ok(!JSON.stringify(kept).includes(PASSWORD));
  assert.equal(((await stat(join(dir, 'state.json'))).mode & 0o777).toString(8), '600');
});

test('fileStore: no file is null, unreadable, corrupt or special files throw, a round trip', async (t) => {
  const dir = await tempDir(t);
  const path = join(dir, 'state.json');
  const store = fileStore(path);
  assert.equal(await store.load(), null);
  await store.save({ lastAttemptAt: 1 });
  assert.deepEqual(await store.load(), { lastAttemptAt: 1 });
  await writeFile(path, '{not json');
  await assert.rejects(store.load(), /not JSON/);
  await writeFile(path, 'x'.repeat(5000));
  await assert.rejects(store.load(), /too large/);
  await assert.rejects(fileStore(dir).load(), /not a regular file/, 'a directory is refused');
  // A FIFO is refused without being opened (it would block a read forever).
  const fifo = join(dir, 'fifo');
  try {
    execFileSync('mkfifo', [fifo]);
  } catch {
    return;
  }
  t.after(async () => {
    // Wakes any reader a regression would leave blocked on it.
    const handle = await open(fifo, fsConstants.O_RDWR | fsConstants.O_NONBLOCK).catch(() => null);
    await handle?.close();
  });
  await assert.rejects(within(fileStore(fifo).load(), 2000, 'fifo'), /not a regular file/);
});
