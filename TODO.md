# TODO — Atrea v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `gi ci` (Prettier, ESLint, tests Node 24 and 22,
  Docker build, store validator), `npm run audit`, then update README,
  `docs/en.md`, `docs/fr.md`, `CHANGELOG.md` and this file.
- No forum topic of its own, no forum post from a module session.
- The `gladys-assistant-integration` topic is added at the first real release only.

## Status

- [x] **Milestone 1 — core** (2026-11-05): the unit by its address and the
      password of its web page, one session kept, the registers page every
      interval (never sooner, even after a restart), the metadata page every
      hour (secondary), one device keyed by the unit ID, mode select and fan
      power behind `allow_commands` (off), "Stop the unit" never held back,
      kept until a mode is chosen, never given up before it left; test
      button, docs en/fr, cover. Tested against a fake unit only (and a real
      HTTP server of gladys-testkit at x20).
- [ ] **Milestone 2 — real unit**: run against a real RD5 unit (see "To check").
- [ ] **Milestone 3 — more**: alarm reset (C10005) and filter
      acknowledgement (C10007) as buttons behind the option (one-shot
      writes of HomeAssistant-Atrea), the translated alarm texts
      (`lang/texts_2.xml`, LZW-compressed), the model (`cfgdir.xml`), the
      temperature asked as a command (10-40 °C, H10710), IN1/IN2 voltages,
      D1-D4 inputs, air flows once the core has a unit for them, the bypass
      once a register for it is documented.

## To check on a real unit

- The exact shape of the pages: the root of `config/xml.xml` (RD5WEB), the
  login answer (`<root>code</root>` assumed: any single element is read),
  the answer of `config/xml.cgi` (any 200 without the "403" text is taken
  as accepted).
- Whether a session expires, and whether signing in again takes a new
  place on the unit (the unit refuses beyond a few users).
- Whether "denied" is answered both to a wrong password and to "too many
  users" (HomeAssistant-Atrea says so): then the refusal after two in a row
  may come from a busy unit; the test button lifts it.
- Whether H10708 (power written) has a coefficient in `params.xml` (pyatrea
  applies one if present; the integration writes the raw percentage and
  confirms on H10714).
- What H10705 reads right after a mode written (immediately, or after a
  delay: then "not applied yet" is the normal first answer), and right
  after the stop (`off` or `rundown`).
- That the stop (manual program, mode off) stops the unit and the weekly
  program does not start it again; that writing H10703 is harmless on units
  that do not use it.
- Whether a forced mode (D1-D4, IN1, IN2) overrides the stop: the stop is
  then resent three times and the status asks to stop the unit on its panel.

## Decisions

- **Version 0.1.0 set by hand** in `package.json`, `package-lock.json`, the
  manifest and `docker_image` (`ghcr.io/lm1lc3n7/gladys-atrea:0.1.0`); the
  manifest test checks the semver shape and that the four agree, never a
  pinned value.
- **References**: pyatrea 0.10.0 (MIT; its LICENSE is the template left with
  "[year] [fullname]", quoted as is) and HomeAssistant-Atrea 6.2.0
  (Apache-2.0), both by Juraj Nyíri, cloned read-only in
  `~/code/ref/lot20/`. No npm library exists: the logic is ported, the HTTP
  client is the integration's own (no User-Agent, nothing that imitates an
  app). Atrea publishes no documentation of this web interface: only the
  registers both references use are read or written, never guessed.
- **RD5 only**: the RD4 registers of pyatrea (H01000 and the like) are not
  used; a unit without H10705 shows a warning in the status.
- **Session**: one code in memory (never in /data: it is a secret); a
  sign-in only on the "403" page, once per request; two refusals in a row
  ("denied", or a session refused right after a sign-in) stop every sign-in;
  /data keeps a 6-bit salted mark of the refused password (64 values: it
  cannot give it back; a new password with the same mark, 1 in 64, needs
  the test button after a restart).
- **The stop** = manual program + mode off (pyatrea `setProgram(MANUAL)` +
  `setMode(OFF)`), as HomeAssistant-Atrea turns the unit off: the weekly
  program would start it again. Confirmed by H10705 read off (0) or
  stopping (`rundown`, 10). No sign-in to another address than the
  configured one (the password belongs to that unit). At container start,
  the kept stop goes first without a session (the password is not known
  before the configuration), then right after the configuration is read.
- **A mode is a start**: with the option, it lifts a kept stop (/data
  forgets it before the first byte). The fan power is refused on a unit off
  or stopping (it may start it) and while a stop is kept.
- **Weekly program**: a mode or a power written under it makes the program
  temporary in the same request (pyatrea, HomeAssistant-Atrea).
- **Device id**: `atrea:id-<unit ID>` (H12300-H12309), `atrea:unit` for a
  unit without these registers; learnt once per address in /data; another ID
  read refuses the commands until the test button accepts it (a new device).
- **Fan power** as a writable `fan/percent` (12 to 100): a "turn off" of a
  voice assistant (0) is refused. The temperature asked is read only.
- **Not published**: air flows (m³/h has no category but water-valve in the
  core), bypass (no register in the references), IN1/IN2/SA1.
- **Categories** `climate`, `environment`; no `keywords`/`countries` (CZ,
  SK, EU in the catalog line).
- **Poll interval** 60 s by default (30 s - 1 h); HomeAssistant-Atrea reads
  every 10 s, the integration keeps the unit's few sessions and its web
  server quiet.
