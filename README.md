# gladys-atrea

[Gladys Assistant](https://gladysassistant.com) external integration for
**Atrea** heat recovery ventilation with an **RD5** regulation, through the
unit's own **web page** on the local network (HTTP, no cloud): current mode,
program, fan power asked and current, outdoor, supply, extract, exhaust and
indoor temperatures, heating and cooling, filters to change, warnings and
alerts; the mode and the fan power behind an off-by-default option, and
"Stop the unit" never behind that option. **Never tested with a real
device. Not affiliated with Atrea.** The web page is plain HTTP: keep the
unit on a trusted network.

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

## How it works

```
Gladys ⇄ SDK ⇄ src/handlers.js ⇄ src/app.js (AtreaApp)
                                  ├─ src/atrea/http.js      one HTTP/1.0 GET at a time, bounded answers
                                  ├─ src/atrea/protocol.js  pages, parsers, decoders (pure)
                                  ├─ src/devices.js         the device and its states (pure)
                                  ├─ src/publisher.js       states within 300/min
                                  └─ src/store.js           /data/atrea-state.json
```

- **Session**: the unit gives a session code at sign-in
  (`config/login.cgi?magic=<md5 of CR LF and the password>`, as pyatrea);
  the integration keeps ONE code in memory and signs in again only when a
  page answers the unit's "403 Forbidden" page, at most once per request.
  Two refusals in a row stop every sign-in until a new password is saved or
  the test button succeeds (a 6-bit salted fingerprint in `/data`, never the
  password).
- **Reads**: the registers page (`config/xml.xml`) every 60 s (30 s – 1 h,
  start to start), the metadata page (`user/params.xml`, warning and alert
  lists) once an hour, secondary (never blocking, never signs in). Never
  sooner than the interval (test button, Discovery, reconnection, unchanged
  configuration, container restart: the time of the last read is kept in
  `/data`, written at most once a minute, before the read). Failures
  retried after 30 s to 5 min, never under the interval.
- **Device**: `ext:<selector>:atrea:id-<unit ID>` (registers H12300 to
  H12309), `ext:<selector>:atrea:unit` for a unit without ID. Every feature
  is always published; no switch, no writable binary.
- **Commands** (`allow_commands`, off by default): one `text/select` (the
  modes the unit lets be chosen, H10709) and one `fan/percent` (12 – 100 %,
  H10708); under the weekly program the program becomes temporary with the
  write (as pyatrea). Decided on a fresh read in the same line, refused on
  another or an unreadable unit ID or an unreadable /data; the power also
  on a unit off or stopping and while a stop is kept; a mode lifts a kept
  stop (saved before the first byte). Written within 3.5 s of the click or
  not at all, confirmed only by the value read back (by 4.3 s).
- **Stop the unit** (protective: manual program and mode off, H10700 to
  H10703 = 0, H10709 = 0): never behind the option, takes the line from
  anything, cancels a command not written yet, retried for 3.5 s (an answer
  stalled 1 s is cut), goes to the address kept in `/data` when the
  configuration is not read yet. Then **kept** in `/data`: never lifted by
  the time, only by a mode chosen from Gladys or by the unit read running
  twice in a row after it was seen off. A stop that never left is never
  given up (sent first at every read, at a new password, at a successful
  test); once sent, resent at most three times when the unit reads running;
  sent again at container start when it may not have landed.
- **Not done**: firmware, settings, schedules, temperature asked, alarm
  reset, filter acknowledgement, translations, air flows, bypass.

## Development

```bash
npm install
npm test             # node --test (fake Gladys of the SDK, fake unit, mocked clock, real clock x20)
npm run lint
npm run format:check
npm run audit
npm run cover        # cover.png, plain Node
```

See [CLAUDE.md](CLAUDE.md) for the rules and [TODO.md](TODO.md) for the
status and the decisions.

## Credits and license

Pages and registers ported from [pyatrea](https://github.com/JurajNyiri/pyatrea)
(MIT) and [HomeAssistant-Atrea](https://github.com/JurajNyiri/HomeAssistant-Atrea)
(Apache-2.0), both by Juraj Nyíri; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). This integration is
licensed under the Apache License 2.0 ([LICENSE](LICENSE)).
