// -----------------------------------------------------------------------------
// The pure parts: the pages of the unit, the HTTP client on fake sockets, the
// configuration and /data repaired.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { normalizeConfig, parseAddress } from '../src/config.js';
import { ERROR_KINDS, httpGet } from '../src/atrea/http.js';
import {
  decodeStatus,
  isForbidden,
  loginKey,
  parseLogin,
  parseParams,
  parseStatus,
  powerValue,
  statusPath,
  writePath,
} from '../src/atrea/protocol.js';
import { normalizeMemory } from '../src/store.js';
import { atreaCore, defaultRegisters } from './fixtures/fakeAtrea.js';

test('the login key is md5 of CR LF and the password (pyatrea)', () => {
  // Computed apart (Python hashlib.md5(b'\r\nsecret')).
  assert.equal(loginKey('secret'), 'a04b5905d48f96f1d4e5464de0ca2ef9');
  assert.match(loginKey('x'), /^[0-9a-f]{32}$/);
  assert.notEqual(loginKey('x'), loginKey('y'));
});

test('paths: the session code, two letters; writes five digits each, bounded', () => {
  const random = () => 0;
  assert.equal(statusPath('5001', random), '/config/xml.xml?auth=5001&aa');
  assert.equal(
    writePath(
      '7',
      [
        ['H10709', 2],
        ['H10708', 100],
      ],
      random,
    ),
    '/config/xml.cgi?auth=7&aa&H1070900002&H1070800100',
  );
  assert.throws(() => writePath('7', [['H1070', 1]]));
  assert.throws(() => writePath('7', [['H10709', -1]]));
  assert.throws(() => writePath('7', [['H10709', 65536]]));
  assert.throws(() => writePath('7', [['H10709', 1.5]]));
});

test('the login answer: denied, a code, anything else unreadable', () => {
  assert.deepEqual(parseLogin('<?xml version="1.0"?><root>denied</root>'), { denied: true });
  assert.deepEqual(parseLogin('<root> 12345 </root>'), { code: '12345' });
  assert.equal(parseLogin('<root>12 45</root>'), undefined);
  assert.equal(parseLogin('<root>a&b</root>'), undefined);
  assert.equal(parseLogin('<root>x</other>'), undefined);
  assert.equal(parseLogin('HTTP: 404 Page'), undefined);
  assert.equal(parseLogin(`<root>${'1'.repeat(33)}</root>`), undefined);
});

test('the 403 page is recognized, a page holding it too', () => {
  assert.ok(isForbidden(200, '<html>HTTP: 403 Forbidden</html>'));
  assert.ok(isForbidden(403, ''));
  assert.ok(!isForbidden(200, '<RD5WEB/>'));
});

test('the registers page: linear, first value wins, no prototype pollution, bounded', () => {
  const map = parseStatus(
    '<RD5WEB><RD5><O I="H10705" V="2"/><O V="3" I="H10705"/><O I="__proto__" V="1"/><O I="I10211" V=""/></RD5></RD5WEB>',
  );
  assert.equal(map.get('H10705'), '2');
  assert.equal(map.has('__proto__'), false);
  assert.equal(map.get('I10211'), '');
  assert.equal(parseStatus('<html>nothing</html>'), undefined);
  const many = `<RD5WEB>${'<O I="H00001" V="1"/>'.repeat(9000)}</RD5WEB>`;
  assert.equal(parseStatus(many), undefined);
  const started = performance.now();
  parseStatus(`<RD5WEB>${'<O '.repeat(100_000)}`);
  assert.ok(performance.now() - started < 2000, 'linear on junk');
});

test('the metadata page: warnings and alerts', () => {
  assert.deepEqual(
    parseParams(
      '<root><params><i id="D1" flag="A"/><i id="D11180" flag="A"/><i flag="W" id="D11183"/></params></root>',
    ),
    { warnings: ['D11183'], alerts: ['D11180'] },
  );
  assert.equal(parseParams('<root/>'), undefined);
});

test('decoding: signed temperatures, strict numbers, writable modes, the unit ID', () => {
  const map = defaultRegisters();
  let v = decodeStatus(map, { warnings: ['D11183'], alerts: ['D11180'] });
  assert.equal(v.outdoor, -5.2);
  assert.equal(v.mode, 'ventilation');
  assert.equal(v.running, true);
  assert.equal(v.program, 'manual');
  assert.equal(v.id, 'ATR1234');
  assert.deepEqual(v.writableModes, [
    'automatic',
    'ventilation',
    'circulation-ventilation',
    'circulation',
    'night-precooling',
    'disbalance',
    'overpressure',
  ]);
  assert.equal(v.alarmCodes, 'none');
  map.set('H11700', '0');
  map.set('I12004', String(0b110));
  v = decodeStatus(map);
  assert.deepEqual(v.writableModes, ['automatic', 'ventilation']);
  assert.equal(v.alarmCodes, undefined, 'unknown without the metadata page');
  for (const bad of ['', ' 1', '1.5', '-1', '0x10', '99999']) {
    map.set('H10714', bad);
    assert.equal(decodeStatus(map).power, undefined, bad);
  }
  map.set('H10705', '10');
  assert.equal(decodeStatus(map).running, false, 'rundown is not running');
  map.set('H10705', '0');
  assert.equal(decodeStatus(map).running, false);
  map.set('H10705', '');
  assert.equal(decodeStatus(map).running, undefined, 'unknown is unknown');
  map.set('H12300', '7');
  assert.equal(decodeStatus(map).id, undefined);
  assert.equal(decodeStatus(map).idUnreadable, true);
});

test('the fan power: a whole number 12 to 100 only', () => {
  for (const ok of [12, 100, '50']) assert.equal(typeof powerValue(ok), 'number', String(ok));
  for (const bad of [11, 101, 50.5, '', ' 50', '5e1', null, true, '0x32']) {
    assert.equal(powerValue(bad), undefined, String(bad));
  }
});

test('the configuration: address, port, password bounds; the option strictly true', () => {
  assert.deepEqual(parseAddress('192.168.1.5'), { host: '192.168.1.5', port: 80 });
  assert.deepEqual(parseAddress('http://Unit.lan:8080/'), { host: 'unit.lan', port: 8080 });
  for (const bad of [
    '0.1.2.3',
    '224.0.0.1',
    '192.168.1.255',
    '192.168.1.0',
    'a b',
    'x:0',
    'a..b',
  ]) {
    assert.equal(parseAddress(bad), undefined, bad);
  }
  assert.equal(normalizeConfig({ allow_commands: 'yes' }).allowCommands, false);
  assert.equal(normalizeConfig({ allow_commands: 'true' }).allowCommands, true);
  assert.equal(normalizeConfig({ password: 'a\r\nb' }).badPassword, true);
  assert.equal(normalizeConfig({ password: 'é'.repeat(33) }).badPassword, true);
  assert.equal(normalizeConfig({ password: ' spaced ' }).password, ' spaced ');
  assert.equal(normalizeConfig({ poll_interval: '' }).pollInterval, 60);
  assert.equal(normalizeConfig({ poll_interval: 5 }).pollInterval, 30);
  const invalid = normalizeConfig({ host: 'my secret pasted here' });
  assert.equal(invalid.address, undefined);
  assert.equal(invalid.invalid, 21);
});

test('/data repaired: an unreadable count is 0, an unknown "sent" is never sent, a future time is now', () => {
  const m = normalizeMemory(
    {
      lastAttemptAt: 9e15,
      stopGuard: { unit: 'u', host: 'h', reasserts: 'x', sent: 'yes', pending: 'maybe' },
      identity: { unit: 'u', id: 'A', platform: '../x' },
      refused: { unit: 'u', salt: 'zz', mark: 3 },
    },
    1000,
  );
  assert.equal(m.lastAttemptAt, 1000);
  assert.equal(m.stopGuard.reasserts, 0);
  assert.equal(m.stopGuard.sent, false);
  assert.equal(m.stopGuard.pending, true);
  assert.equal(m.identity, null);
  assert.equal(m.refused, null);
});

// --- The HTTP client on fake sockets --------------------------------------------

class Socket extends EventEmitter {
  constructor() {
    super();
    this.written = '';
    this.destroyed = false;
  }
  write(text) {
    this.written += text;
  }
  destroy() {
    this.destroyed = true;
  }
}

function client(options = {}) {
  const socket = new Socket();
  const request = httpGet({
    host: '10.0.0.2',
    port: 80,
    path: '/config/xml.xml?auth=1&ab',
    connect: () => socket,
    timeoutMs: 1000,
    ...options,
  });
  return { socket, request };
}

test('http: Content-Length, in several chunks', async () => {
  const { socket, request } = client();
  socket.emit('connect');
  socket.emit('data', Buffer.from('HTTP/1.0 200 OK\r\nContent-Le'));
  socket.emit('data', Buffer.from('ngth: 5\r\n\r\nhel'));
  socket.emit('data', Buffer.from('lo'));
  assert.deepEqual(await request.promise, { status: 200, body: 'hello' });
  assert.equal(socket.destroyed, true);
  assert.match(
    socket.written,
    /^GET \/config\/xml\.xml\?auth=1&ab HTTP\/1\.0\r\nHost: 10\.0\.0\.2\r\n/,
  );
});

test('http: chunked, and until the close', async () => {
  let c = client();
  c.socket.emit('connect');
  c.socket.emit(
    'data',
    Buffer.from(
      'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n2\r\nde\r\n0\r\n\r\n',
    ),
  );
  assert.equal((await c.request.promise).body, 'abcde');
  c = client();
  c.socket.emit('connect');
  c.socket.emit('data', Buffer.from('HTTP/1.0 200 OK\r\n\r\nxyz'));
  c.socket.emit('end');
  assert.equal((await c.request.promise).body, 'xyz');
});

test('http: oversized body or headers cut before the end; data before the request refused', async () => {
  let c = client({ maxBody: 10 });
  c.socket.emit('connect');
  c.socket.emit('data', Buffer.from('HTTP/1.0 200 OK\r\nContent-Length: 11\r\n\r\n'));
  await assert.rejects(c.request.promise, (e) => e.kind === ERROR_KINDS.PROTOCOL && e.sent);
  c = client({ maxBody: 10 });
  c.socket.emit('connect');
  c.socket.emit('data', Buffer.from('HTTP/1.0 200 OK\r\n\r\n'));
  c.socket.emit('data', Buffer.alloc(100_000, 0x20));
  await assert.rejects(c.request.promise, (e) => e.kind === ERROR_KINDS.PROTOCOL);
  c = client();
  c.socket.emit('connect');
  c.socket.emit('data', Buffer.alloc(9000, 0x41));
  await assert.rejects(c.request.promise, (e) => e.kind === ERROR_KINDS.PROTOCOL);
  c = client();
  c.socket.emit('data', Buffer.from('HTTP/1.0 200 OK\r\n\r\n'));
  await assert.rejects(c.request.promise, (e) => e.kind === ERROR_KINDS.PROTOCOL && !e.sent);
});

test('http: refused before the connection is not sent; closed after is sent', async () => {
  let c = client();
  c.socket.emit('error', new Error('ECONNREFUSED'));
  await assert.rejects(c.request.promise, (e) => e.kind === ERROR_KINDS.UNREACHABLE && !e.sent);
  c = client();
  c.socket.emit('connect');
  c.socket.emit('close');
  await assert.rejects(c.request.promise, (e) => e.kind === ERROR_KINDS.CLOSED && e.sent);
});

test('http: beforeSend throwing sends nothing; a passed deadline is LATE', async () => {
  let c = client({
    beforeSend: () => {
      throw new Error('no');
    },
  });
  c.socket.emit('connect');
  await assert.rejects(c.request.promise, /no/);
  assert.equal(c.socket.written, '');
  c = client({ startBy: 0, now: () => 1 });
  c.socket.emit('connect');
  await assert.rejects(c.request.promise, (e) => e.kind === ERROR_KINDS.LATE && !e.sent);
  assert.equal(c.socket.written, '');
});

test('http: a stall (no byte for idleMs) and the overall timeout end it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let c = client({ idleMs: 100, timeoutMs: 5000 });
  c.socket.emit('connect');
  c.socket.emit('data', Buffer.from('HTTP/1.0 200 OK\r\nContent-Length: 9\r\n\r\n<'));
  t.mock.timers.tick(150);
  await assert.rejects(c.request.promise, (e) => e.kind === ERROR_KINDS.STALLED && e.sent);
  c = client({ timeoutMs: 300 });
  t.mock.timers.tick(400);
  await assert.rejects(c.request.promise, (e) => e.kind === ERROR_KINDS.TIMEOUT && !e.sent);
});

test('http: a path with a space, CR or LF is never sent', async () => {
  for (const path of ['/a b', '/a\r\nX: y', 'relative']) {
    const c = client({ path });
    await assert.rejects(c.request.promise, (e) => e.kind === ERROR_KINDS.PROTOCOL);
    assert.equal(c.socket.written, '');
  }
});

test('the fake unit answers as pyatrea expects (sanity of the fixture)', () => {
  const core = atreaCore();
  assert.match(core.answer('/config/xml.xml?auth=&ab').body, /403 Forbidden/);
  const login = core.answer(`/config/login.cgi?magic=${loginKey(core.password)}&auth=&ab`).body;
  const { code } = parseLogin(login);
  assert.ok(parseStatus(core.answer(`/config/xml.xml?auth=${code}&ab`).body).has('H10705'));
});
