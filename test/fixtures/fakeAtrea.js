// -----------------------------------------------------------------------------
// A fake Atrea unit (RD5 regulation) behind the injected `connect` (no
// network): HTTP/1.0 over a fake socket, the pages pyatrea reads (sign-in,
// registers, metadata, writes), a limited number of sessions, writes applied,
// answers after a delay (mocked timers). It counts the connections open at
// once (the integration must never open a second one). `core.answer(path)` is
// the same logic for a real HTTP server (gladys-testkit). Values made up,
// never from a real unit.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

export const HOST = '192.168.1.90';
export const NOW = Date.UTC(2026, 10, 5, 10, 0, 0);
export const PASSWORD = 'secret-pw-42';
export const UNIT_ID = 'ATR1234';

const md5 = (text) => createHash('md5').update(text, 'utf8').digest('hex');

/** A unit running in ventilation, manual program, 50 %, no alarm. */
export function defaultRegisters(id = UNIT_ID) {
  const r = new Map(
    Object.entries({
      H10705: '2',
      H10709: '2',
      H10700: '0',
      H10701: '0',
      H10702: '0',
      H10703: '0',
      H10714: '50',
      H10708: '50',
      H10704: '50',
      H10706: '210',
      H10712: '0',
      I10211: String(65536 - 52),
      I10212: '185',
      I10213: '214',
      I10214: '12',
      I10215: '220',
      I11420: '30',
      C10215: '0',
      C10216: '1',
      D11183: '0',
      D11180: '0',
      D11181: '0',
      I12004: '254',
      H11700: '1',
      I00020: '2',
      I00021: '1',
      I00022: '32',
    }),
  );
  for (let i = 0; i < 10; i += 1) {
    r.set(`H123${String(i).padStart(2, '0')}`, String(i < id.length ? id.charCodeAt(i) : 0));
  }
  return r;
}

const FORBIDDEN = '<html><body>HTTP: 403 Forbidden</body></html>';

/** The logic of the unit: a path (with its query) in, `{ status, body }` out. */
export function atreaCore({ registers = defaultRegisters() } = {}) {
  const core = {
    registers,
    password: PASSWORD,
    requireAuth: true,
    sessions: [],
    maxSessions: 2,
    nextCode: 5000,
    /** Writes acknowledged but not applied. */
    ignoreWrites: false,
    /** The program writes (H10700-H10703) ignored, the rest applied. */
    ignoreProgram: false,
    /** A write of mode 0 shows "rundown" (10) instead of "off" (0). */
    rundown: false,
    /** The metadata page refused or broken. */
    paramsStatus: 200,
    paramsBody: undefined,
    statusBody: undefined,
    /** Called with the writes ([register, value] pairs) before they are applied. */
    onWrite: undefined,
    /** Every request: { path, query }. */
    log: [],
    xml() {
      const items = [...core.registers]
        .map(([id, value]) => `<O I="${id}" V="${value}"/>`)
        .join('');
      return `<?xml version="1.0" encoding="UTF-8"?>\n<RD5WEB><RD5><INTEGER>${items}</INTEGER></RD5></RD5WEB>`;
    },
    params() {
      return (
        '<?xml version="1.0"?><root><params>' +
        '<i id="D11180" flag="A"/><i id="D11181" flag="W"/><i id="D11183" flag="W"/>' +
        '<i id="H10714" coef="1"/></params></root>'
      );
    },
    valid(query) {
      return !core.requireAuth || core.sessions.includes(query.get('auth'));
    },
    apply(writes) {
      core.onWrite?.(writes);
      if (core.ignoreWrites) return;
      for (const [register, value] of writes) {
        if (core.ignoreProgram && /^H1070[0-3]$/.test(register)) continue;
        core.registers.set(register, String(value));
        if (register === 'H10709') {
          core.registers.set('H10705', String(value === 0 && core.rundown ? 10 : value));
        }
        if (register === 'H10708') {
          core.registers.set('H10714', String(value));
          core.registers.set('H10704', String(value));
        }
      }
    },
    answer(url) {
      const parsed = new URL(url, 'http://unit');
      const query = parsed.searchParams;
      const entry = { path: parsed.pathname, query: Object.fromEntries(query), url };
      core.log.push(entry);
      switch (parsed.pathname) {
        case '/config/login.cgi': {
          const ok = query.get('magic') === md5(`\r\n${core.password}`);
          if (!ok || core.sessions.length >= core.maxSessions) {
            return { status: 200, body: '<?xml version="1.0"?><root>denied</root>' };
          }
          const code = String((core.nextCode += 1));
          core.sessions.push(code);
          return { status: 200, body: `<?xml version="1.0"?><root>${code}</root>` };
        }
        case '/config/xml.xml':
          if (!core.valid(query)) return { status: 200, body: FORBIDDEN };
          return { status: 200, body: core.statusBody ?? core.xml() };
        case '/user/params.xml':
          if (!core.valid(query)) return { status: 200, body: FORBIDDEN };
          return { status: core.paramsStatus, body: core.paramsBody ?? core.params() };
        case '/config/xml.cgi': {
          if (!core.valid(query)) return { status: 200, body: FORBIDDEN };
          const writes = [];
          for (const key of query.keys()) {
            const m = /^([A-Z]\d{5})(\d{5})$/.exec(key);
            if (m) writes.push([m[1], Number(m[2])]);
          }
          entry.writes = writes;
          core.apply(writes);
          return { status: 200, body: '<?xml version="1.0"?><root>OK</root>' };
        }
        default:
          return { status: 404, body: 'HTTP: 404 Page' };
      }
    },
    writes: () => core.log.filter((e) => e.writes).map((e) => e.writes),
    logins: () => core.log.filter((e) => e.path === '/config/login.cgi').length,
    reads: () => core.log.filter((e) => e.path === '/config/xml.xml').length,
  };
  return core;
}

class FakeSocket extends EventEmitter {
  constructor(unit) {
    super();
    this.unit = unit;
    this.destroyed = false;
    this.buffer = '';
  }

  write(bytes) {
    if (this.destroyed) throw new Error('write after destroy');
    this.buffer += String(bytes);
    if (this.buffer.includes('\r\n\r\n')) this.unit.handle(this, this.buffer);
    return true;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.unit.open.delete(this);
    setImmediate(() => this.emit('close'));
  }

  setNoDelay() {}
}

/**
 * The fake unit on fake sockets. Knobs (change them live): `down` (refused),
 * `connectDelay`, `delay` (before the answer), `delays` (by path), `silent`
 * (paths never answered), `stall` (paths whose answer stops after the
 * headers), `closeOn` (paths closed unanswered), `applyClosedWrites`, `big`
 * (paths answered with a huge body).
 */
export function fakeAtrea(options = {}) {
  const core = atreaCore(options);
  const unit = {
    core,
    open: new Set(),
    maxOpen: 0,
    connections: 0,
    refused: 0,
    down: false,
    /** Hosts that refuse the connection. */
    downHosts: new Set(),
    connectDelay: 5,
    delay: 10,
    delays: {},
    silent: new Set(),
    stall: new Set(),
    closeOn: new Set(),
    big: new Set(),
    applyClosedWrites: false,
    /** Sign-ins applied even after their connection closed (a place taken we never saw). */
    applyClosedLogins: false,
    /** The next connections refused; `refuseAfter403`: that many refused right after a "403" page. */
    refuseNext: 0,
    refuseAfter403: 0,
    hosts: [],
    /** The raw request texts received. */
    raw: [],
    handle(socket, text) {
      unit.raw.push(text);
      const line = text.split('\r\n')[0];
      const m = /^GET (\S+) HTTP\/1\.0$/.exec(line);
      const url = m ? m[1] : '/';
      const path = new URL(url, 'http://unit').pathname;
      if (unit.closeOn.has(path)) {
        setTimeout(() => socket.destroy(), unit.delay);
        return;
      }
      if (unit.silent.has(path)) {
        core.log.push({ path, silent: true });
        return;
      }
      setTimeout(() => {
        if (socket.destroyed) {
          if (unit.applyClosedWrites && path === '/config/xml.cgi') core.answer(url);
          if (unit.applyClosedLogins && path === '/config/login.cgi') core.answer(url);
          return;
        }
        const { status, body } = core.answer(url);
        if (unit.refuseAfter403 > 0 && body.includes('403 Forbidden')) {
          unit.refuseNext = unit.refuseAfter403;
          unit.refuseAfter403 = 0;
        }
        if (unit.stall.has(path)) {
          socket.emit('data', Buffer.from(`HTTP/1.0 ${status} OK\r\nContent-Length: 999\r\n\r\n<`));
          return;
        }
        if (unit.big.has(path)) {
          socket.emit('data', Buffer.from(`HTTP/1.0 200 OK\r\n\r\n`));
          for (let i = 0; i < 40 && !socket.destroyed; i += 1) {
            socket.emit('data', Buffer.alloc(16 * 1024, 0x20));
          }
          return;
        }
        const payload = Buffer.from(body, 'latin1');
        socket.emit(
          'data',
          Buffer.concat([
            Buffer.from(
              `HTTP/1.0 ${status} X\r\nContent-Type: text/xml\r\nContent-Length: ${payload.length}\r\n\r\n`,
            ),
            payload,
          ]),
        );
        socket.emit('end');
        socket.destroy();
      }, unit.delays[path] ?? unit.delay);
    },
    connect(host) {
      const socket = new FakeSocket(unit);
      unit.hosts.push(host);
      unit.connections += 1;
      setTimeout(() => {
        if (socket.destroyed) return;
        const refuse = unit.refuseNext > 0;
        if (refuse) unit.refuseNext -= 1;
        if (refuse || unit.down || unit.downHosts.has(host)) {
          unit.refused += 1;
          socket.emit('error', Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }));
          return;
        }
        unit.open.add(socket);
        unit.maxOpen = Math.max(unit.maxOpen, unit.open.size);
        socket.emit('connect');
      }, unit.connectDelay);
      return socket;
    },
  };
  unit.connectFn = (host) => unit.connect(host);
  return unit;
}

export const settle = async (rounds = 20) => {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};
