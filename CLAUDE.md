# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration** of type `device`: a Node.js
service (Node 22+, ESM, no build step) in its own sandboxed Docker container,
talking to Gladys through `@gladysassistant/integration-sdk` (v0.16), its only
runtime dependency (HTTP goes through `node:net`). It reads an Atrea
ventilation unit (RD5 regulation) through the unit's own web page (plain
HTTP, port 80, password of the web page, no cloud) and shows it as one
Gladys device; the mode and the fan power behind an off-by-default option,
"Stop the unit" never behind it. Never tested with a real device, not
affiliated with Atrea. Read **[TODO.md](./TODO.md) first**: status,
decisions, next milestones.

## Commands

```bash
npm install
npm test                                  # node --test --test-timeout=60000
node --test test/commands.test.js         # one file
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run audit                             # npm audit --omit=dev
npm run cover                             # cover.png (800x534), plain Node
gi ci                                     # the whole CI locally (VM tooling)
```

## Architecture

```
index.js                  SDK bootstrap only (boot(): a stop pending in /data goes first)
src/handlers.js           every SDK handler -> the app (shared with the tests)
src/app.js                AtreaApp: the line (one request at a time), the session, polling,
                          backoff, device, states, badge, status, test button, commands, kept stop
src/atrea/http.js         one HTTP/1.0 GET on its own connection: bounded, error kinds, beforeSend/startBy
src/atrea/protocol.js     paths, login key, page parsers, decoders (pure)
src/devices.js            -> the Gladys device and its states (pure)
src/publisher.js          states within 300/min
src/store.js              /data/atrea-state.json: last read, identity, address, kept stop, refusal mark
src/config.js             config_schema normalized (host, password, allow_commands, interval, language)
src/constants.js          paths, registers, modes, feature roles, ranges, limits, timings
src/i18n.js               runtime texts (en/fr)
test/fixtures/fakeAtrea.js  the fake unit (injected connector, and the same logic for a real HTTP server)
test/kit/                 the parts of gladys-testkit used (real HTTP server, real clock)
scripts/cover.mjs         cover.png generator
```

## Rules

- **External ids are forever**: device `atrea:id-<unit ID>` (or `atrea:unit`
  for a unit without ID), learnt once and kept in /data; feature roles in
  `FEATURES` of `src/constants.js`. Every role is always built.
- Manifest keys (`host`, `password`, `allow_commands`, `poll_interval`,
  `language`, the action `test_connection`) are frozen.
- **One request at a time, one session**: everything goes through `useLine`;
  a command takes the line from a poll, the stop from anything. A sign-in
  only on the unit's "403" page, at most once per request; two refusals in a
  row stop every sign-in until a new password or a successful test.
- **The password and the session code** never reach the logs, /data, a
  status or an error; /data keeps only a 6-bit salted mark of a refused
  password. Never log a path (it carries the session code).
- **Commands**: never a switch nor a writable binary; the mode and the power
  refused unless `allow_commands` (checked on arrival and in `beforeSend`);
  decided on a fresh read in the same line; written within 3.5 s; confirmed
  only by a read back equal to the value asked; never retried; the ack never
  waits for Gladys. Every value written is bounded (power 12-100, modes of
  the unit's list, registers of `WRITE_REG` only).
- **The stop is never held back** (option, other command, stuck read,
  backoff, unit ID, /data, configuration not read). A stop that never left
  is never given up; only a send that left counts. The kept stop is never
  lifted by the time: only by a mode chosen with the option or by the unit
  read running twice in a row after it was seen off.
- Never read sooner than the interval (button, scan, reconnection, restart).
- **Answers are hostile**: bounded in size and time, parsed linearly into
  Maps, strict numbers (`''` is never 0), a text never published as a
  measure; never log what is received.
- **/data**: every wait on it is bounded; an unreadable or special file is
  never taken for an empty one.
- Units only from the core's `DEVICE_FEATURE_UNITS_BY_CATEGORY`.
- Files are UTF-8 without BOM (`test/encoding.test.js`); tests never touch
  the network, except `test/realclock.test.js` (127.0.0.1 only).
- Code, comments, README in English; `docs/en.md` and `docs/fr.md` kept in sync.
- Every user-visible change adds a line under `## [Unreleased]` in
  `CHANGELOG.md`; versions belong to the Release workflow.
