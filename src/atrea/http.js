// -----------------------------------------------------------------------------
// The only network access: one HTTP/1.0 GET on its own TCP connection, closed
// after the answer (the integration never opens a second one at the same time:
// src/app.js holds "the line").
//
// - The request is written by hand ("GET <path> HTTP/1.0", Host, Connection:
//   close, Accept): no User-Agent, nothing that imitates the web page of the
//   unit or an app. A path holding a space, CR, LF or a control byte is
//   refused before anything is sent.
// - The answer is bounded: 8 KB of headers, 512 KB of body (a longer one is
//   cut as soon as it passes the bound, never read whole), Content-Length or
//   chunked or "until the close"; every wait is bounded: the connection, the
//   whole answer, and the silence between two chunks (`idleMs`).
// - Errors say whether the request may have left: `sent` is set as soon as
//   the bytes are handed to the socket, so a command that may have reached
//   the unit is never reported "not sent".
// - `beforeSend` and `startBy` are checked right before the bytes go.
// - Nothing received is ever logged, nor the path (it carries the session).
// -----------------------------------------------------------------------------

import { createConnection } from 'node:net';
import { LIMITS } from '../constants.js';

export const ERROR_KINDS = {
  /** The connection was not opened: nothing sent. */
  UNREACHABLE: 'unreachable',
  /** No (complete) answer in time. */
  TIMEOUT: 'timeout',
  /** The answer stopped coming (no byte for too long). */
  STALLED: 'stalled',
  /** The unit closed the connection, or a socket error. */
  CLOSED: 'closed',
  /** An answer that cannot be read (status line, size, XML). */
  PROTOCOL: 'protocol',
  /** An HTTP status other than 200. */
  HTTP: 'http',
  /** The unit asks for a session (its "403 Forbidden" page). */
  FORBIDDEN: 'forbidden',
  /** The unit answered "denied" to the password. */
  DENIED: 'denied',
  /** A session is needed and no password is configured, or it was refused: no login tried. */
  NO_LOGIN: 'no-login',
  /** Ended by the integration (a command took the line, a new configuration). */
  ABORTED: 'aborted',
  /** The deadline of a command passed before its bytes left: nothing sent. */
  LATE: 'late',
};

export class AtreaError extends Error {
  constructor(kind, message, { sent = false, status } = {}) {
    super(message);
    this.kind = kind;
    this.sent = sent;
    this.status = status;
  }
}

/** A short reason for the logs and the status (never the bytes received). */
export function errorReason(err) {
  if (err instanceof AtreaError) {
    return err.kind === ERROR_KINDS.HTTP && Number.isInteger(err.status)
      ? `HTTP ${err.status}`
      : err.kind;
  }
  return 'error';
}

/** The default connector: a plain TCP socket, no delay. */
export function tcpConnect(host, port) {
  const socket = createConnection({ host, port });
  socket.setNoDelay?.(true);
  return socket;
}

const SAFE_PATH = /^\/[\x21-\x7e]{0,2000}$/;
const SAFE_HOST = /^[a-z0-9.-]{1,253}$/;

/** The head of an answer: status and headers (lower-cased names), or undefined. */
function parseHead(text) {
  const lines = text.split('\r\n');
  const match = /^HTTP\/1\.[01] (\d{3})(?: |$)/.exec(lines[0]);
  if (!match) return undefined;
  const headers = new Map();
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(':');
    if (colon <= 0) return undefined;
    headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  return { status: Number(match[1]), headers };
}

/** A chunked body, decoded; undefined when it is not complete or not valid. */
function unchunk(buffer) {
  const parts = [];
  let at = 0;
  for (;;) {
    const end = buffer.indexOf('\r\n', at);
    if (end < 0 || end - at > 16) return undefined;
    const size = /^([0-9a-fA-F]{1,8})(?:;[^\r\n]*)?$/.exec(
      buffer.subarray(at, end).toString('latin1'),
    );
    if (!size) return undefined;
    const length = parseInt(size[1], 16);
    if (length === 0) return Buffer.concat(parts);
    const start = end + 2;
    if (start + length + 2 > buffer.length) return undefined;
    parts.push(buffer.subarray(start, start + length));
    at = start + length + 2;
  }
}

/**
 * One GET. Returns `{ promise, abort(message) }`; the promise resolves
 * `{ status, body }` (body: latin1 text) or rejects an AtreaError (or the
 * error `beforeSend` threw, nothing sent).
 */
export function httpGet({
  host,
  port,
  path,
  connect = tcpConnect,
  timers = globalThis,
  now = () => performance.now(),
  timeoutMs,
  idleMs = timeoutMs,
  maxBody = LIMITS.maxBody,
  beforeSend,
  startBy,
}) {
  let socket;
  let sent = false;
  let settled = false;
  let resolveFn;
  let rejectFn;
  let total;
  let idle;
  const chunks = [];
  let size = 0;
  let head;
  let bodyStart = -1;
  const promise = new Promise((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  const clear = () => {
    timers.clearTimeout(total);
    timers.clearTimeout(idle);
  };
  const end = (err, value) => {
    if (settled) return;
    settled = true;
    clear();
    try {
      socket?.destroy();
    } catch {
      // Already gone.
    }
    if (err) rejectFn(err);
    else resolveFn(value);
  };
  const fail = (kind, message) => end(new AtreaError(kind, message, { sent }));
  const armIdle = () => {
    timers.clearTimeout(idle);
    idle = timers.setTimeout(() => fail(ERROR_KINDS.STALLED, 'answer stalled'), idleMs);
  };

  /** The answer, once complete (or at the close when it has no length). */
  const complete = (atClose) => {
    const buffer = Buffer.concat(chunks, size);
    if (bodyStart < 0) {
      const at = buffer.indexOf('\r\n\r\n');
      if (at < 0) {
        if (size > LIMITS.maxHeader) fail(ERROR_KINDS.PROTOCOL, 'headers too large');
        else if (atClose) fail(ERROR_KINDS.CLOSED, 'closed before the answer');
        return;
      }
      if (at > LIMITS.maxHeader) {
        fail(ERROR_KINDS.PROTOCOL, 'headers too large');
        return;
      }
      head = parseHead(buffer.subarray(0, at).toString('latin1'));
      if (!head) {
        fail(ERROR_KINDS.PROTOCOL, 'not an HTTP answer');
        return;
      }
      bodyStart = at + 4;
    }
    const body = buffer.subarray(bodyStart);
    if (body.length > maxBody + (head.headers.has('transfer-encoding') ? 64 * 1024 : 0)) {
      fail(ERROR_KINDS.PROTOCOL, 'answer too large');
      return;
    }
    const lengthText = head.headers.get('content-length');
    const chunked = /chunked/i.test(head.headers.get('transfer-encoding') ?? '');
    let text;
    if (chunked) {
      const decoded = unchunk(body);
      if (decoded === undefined) {
        if (atClose) fail(ERROR_KINDS.CLOSED, 'closed inside the answer');
        return;
      }
      if (decoded.length > maxBody) {
        fail(ERROR_KINDS.PROTOCOL, 'answer too large');
        return;
      }
      text = decoded.toString('latin1');
    } else if (lengthText !== undefined) {
      if (!/^\d{1,9}$/.test(lengthText) || Number(lengthText) > maxBody) {
        fail(ERROR_KINDS.PROTOCOL, 'answer too large or length unreadable');
        return;
      }
      const length = Number(lengthText);
      if (body.length < length) {
        if (atClose) fail(ERROR_KINDS.CLOSED, 'closed inside the answer');
        return;
      }
      text = body.subarray(0, length).toString('latin1');
    } else {
      if (!atClose) return;
      text = body.toString('latin1');
    }
    end(undefined, { status: head.status, body: text });
  };

  const abort = (message = 'aborted') => fail(ERROR_KINDS.ABORTED, message);

  if (typeof path !== 'string' || !SAFE_PATH.test(path) || !SAFE_HOST.test(String(host))) {
    end(new AtreaError(ERROR_KINDS.PROTOCOL, 'unsafe request refused'));
    return { promise, abort };
  }
  const hostHeader = port === 80 ? host : `${host}:${port}`;
  const request = `GET ${path} HTTP/1.0\r\nHost: ${hostHeader}\r\nAccept: */*\r\nConnection: close\r\n\r\n`;

  total = timers.setTimeout(
    () => fail(ERROR_KINDS.TIMEOUT, sent ? 'no answer in time' : 'connection timed out'),
    timeoutMs,
  );
  try {
    socket = connect(host, port);
  } catch {
    fail(ERROR_KINDS.UNREACHABLE, 'connection failed');
    return { promise, abort };
  }
  socket.on('connect', () => {
    if (settled) return;
    if (startBy !== undefined && now() > startBy) {
      fail(ERROR_KINDS.LATE, 'too late to send');
      return;
    }
    try {
      beforeSend?.();
    } catch (err) {
      end(err);
      return;
    }
    sent = true;
    armIdle();
    try {
      socket.write(request);
    } catch {
      fail(ERROR_KINDS.CLOSED, 'write failed');
    }
  });
  socket.on('data', (chunk) => {
    if (settled) return;
    if (!sent) {
      // Bytes before the request: never a valid answer.
      fail(ERROR_KINDS.PROTOCOL, 'data before the request');
      return;
    }
    armIdle();
    size += chunk.length;
    if (size > LIMITS.maxHeader + maxBody + 64 * 1024) {
      fail(ERROR_KINDS.PROTOCOL, 'answer too large');
      return;
    }
    chunks.push(chunk);
    complete(false);
  });
  socket.on('error', () => {
    fail(sent ? ERROR_KINDS.CLOSED : ERROR_KINDS.UNREACHABLE, 'socket error');
  });
  socket.on('end', () => complete(true));
  socket.on('close', () => {
    if (!settled) {
      if (sent) complete(true);
      if (!settled) fail(sent ? ERROR_KINDS.CLOSED : ERROR_KINDS.UNREACHABLE, 'closed');
    }
  });
  return { promise, abort };
}
