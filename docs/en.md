# Atrea for Gladys

Shows an **Atrea** heat recovery ventilation unit with an **RD5** regulation
(Duplex, ECV…) in Gladys, through the unit's own **web page** on your local
network, without any cloud or account. Unofficial integration, **not
affiliated with Atrea**. **Never tested with a real device**: Atrea
publishes no documentation of this web interface; the integration reads and
writes the pages and registers that the open-source pyatrea library and the
HomeAssistant-Atrea integration (Home Assistant) use; please report what you
see.

## Before you start

- The unit must be on your network and its web page must open from a
  browser (port 80). Give it a fixed IP address in your router.
- Note the **password of the web page** (leave the field empty if the page
  asks for none). The unit accepts only a few signed-in users at once:
  Gladys keeps a single session and signs in again only when the unit asks
  for it.
- The web page is plain HTTP: the sign-in goes over your local network like
  the one of your browser. Keep the unit on a trusted network.

## Installation

1. Install the integration from the Gladys store.
2. Enter the **IP address of the unit** (port 80 unless you add one) and
   the **password of its web page**; save.
3. Open the **Discovery** tab and add the unit.

## What you get

One device, **Atrea ventilation**, with:

| Feature                                                                | Notes                                                                                                                                                                                                                                                              |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Outdoor, supply, extract, exhaust, indoor, average outdoor temperature | °C                                                                                                                                                                                                                                                                 |
| Temperature asked                                                      | °C, read only                                                                                                                                                                                                                                                      |
| Fan power asked                                                        | %, 12 to 100, a command (see below)                                                                                                                                                                                                                                |
| Current fan power                                                      | %, read only                                                                                                                                                                                                                                                       |
| Ventilation mode                                                       | list: automatic, ventilation, circulation and ventilation, circulation, night precooling, disbalance, overpressure                                                                                                                                                 |
| Current mode                                                           | text: `off`, `automatic`, `ventilation`, `circulation-ventilation`, `circulation`, `night-precooling`, `disbalance`, `overpressure`, `periodic-ventilation`, `startup`, `rundown`, `defrosting`, `external`, `hp-defrosting`, `in1`, `in2`, `d1`, `d2`, `d3`, `d4` |
| Control program                                                        | text: `manual`, `weekly`, `temporary`                                                                                                                                                                                                                              |
| Unit running                                                           | 1 = running; 0 = off or stopping (`rundown`)                                                                                                                                                                                                                       |
| Heating, cooling, filters to change                                    | read only, 1 = yes                                                                                                                                                                                                                                                 |
| Active alerts, active warnings, alarm codes                            | counts; text `none` or the codes of the unit (`D11180, D11183`)                                                                                                                                                                                                    |
| Stop the unit                                                          | button                                                                                                                                                                                                                                                             |

A value outside its range, empty or not a number is never published: Gladys
keeps the last known value. The alert and warning lists come from a second
page of the unit, read once an hour: when it fails, the other values are
published anyway and the alarm features stay unknown until it is read. The
air flows (m³/h) and the bypass are not published.

The unit is read every 60 s (30 s to 1 h). The test button, a Discovery
scan, a reconnection of Gladys or a restart of the integration never read it
sooner than the interval. Reads outside the interval:

- every command reads the unit right before writing, then reads it back;
- "Stop the unit" and its resends;
- 5 s then 20 s after a command or a stop not confirmed, or after a stop
  that follows a command not confirmed;
- a new address saved is read at once.

## The password

The password is kept by Gladys in its database, never shown again, sent
only to the unit. It is never written in the logs nor in the integration's
files. When the unit answers "denied" (wrong password, or too many users
signed in to the unit), the next read tries once more; a second refusal in
a row stops every sign-in: the status says so, until you save the configuration (the same password counts: one more try)
or press **Test the connection** (one try per press). After a
restart, the integration remembers that this password was refused (as a
short fingerprint that cannot give the password back), so it does not try
it again on its own.

## Commands

The mode and the fan power are refused unless **Allow the commands** is on
(off by default). No switch: a voice assistant's "turn everything off" never
reaches the ventilation.

- Every command reads the unit right before writing (mode, program, fan
  power, the modes the unit lets be chosen, unit ID), writes nothing when
  the value already is right, and is confirmed only when the unit reads the
  value asked back. A read back still showing the state before answers "not
  applied yet"; a command that may have reached the unit without being
  confirmed answers "sent, without confirmation": check the unit a few
  seconds later. A command that cannot be sent within 3.5 s is refused and
  nothing is sent.
- Under the **weekly program**, a change makes the program **temporary**,
  as the unit's web page does.
- Refused: a mode the unit does not let be chosen (its list of writable
  modes, read each time), when the **unit ID** read differs from the one
  learnt or cannot be read (see below), when **/data** cannot be read or
  written, when the state of the unit cannot be read just before, when no
  session can be opened (no password, or refused).
- A **mode starts a unit that is off**: with the option on, choosing a mode
  is how the unit is started again from Gladys. It lifts a stop sent from
  Gladys (see below).
- The **fan power** is a whole number from 12 to 100 %; it is refused on a
  unit that is **off or stopping**, and while a **stop sent from Gladys is
  kept**: choose a mode first.

### Stop the unit

"Stop the unit" sets the manual program and the mode off (the weekly program
would start the unit again). It does **not** depend on the option, on
another command (a command not written yet is cancelled), on a read in
progress or stuck (it is interrupted), on a failed read or a wait between
two tries, on the unit ID, on /data, nor on the configuration not read
again from Gladys yet or made invalid since (it then goes to the address of
the kept stop, else the last valid one kept in /data). It is tried again for
3.5 s after the press; an answer to the stop that stops coming for 1 s is
cut and the stop sent again. When the session expired, it signs in once per
press (the sign-in may take the whole 3.5 s: each sign-in takes a place on
the unit). It is confirmed when the unit reads the mode off (or stopping)
and the manual program; a unit read off but still in another program is
never taken as stopped: the stop is sent again (three sends at most).

It can fail in these cases only, and the answer says so:

- no address known (never a valid one configured): "not sent";
- the unit asks for a session and no password can be tried (none saved,
  refused twice, or the stop goes to another address than the configured
  one): "not sent", kept, and sent first as soon as a password is saved or
  the test button succeeds;
- the session expired and the sign-in of the press failed (no answer in
  time, connection closed, unreadable answer; a sign-in that could not even
  connect is tried again within the 3.5 s; one that left is never sent
  twice in a press: it takes a place on the unit): "not sent", kept, sent
  first at the next read;
- the unit refuses the password: "not sent", kept, sent first at the next
  read;
- the unit cannot be reached within 3.5 s: "not sent" (or "not sent yet"
  while it still tries), kept, sent first at the next read;
- no answer, an error answer, or the unit read back still running: "sent,
  without confirmation".

The stop is then **kept** (in /data, with the address). A stop that never
reached the unit is never given up: it is sent first at every read until it leaves (while no password can be
tried, it waits for a new password or a successful test); only a send that actually left counts as a try. The kept stop is
never lifted by the time, only by a mode chosen from Gladys (with the
option), or when the unit is read running **twice in a row** after it was
seen off (started from its panel). While it is kept, a read
that finds the unit running before it was seen off (or after a command that
could still land) sends the stop again, three sends at most; the status
says so. A stop that may not have landed when the integration stopped is
sent again when it restarts, before the configuration is read again when
the unit asks for no password, else right after it.

## Identity of the unit

The device is tied to the **unit ID** the unit gives (registers H12300 to
H12309), learnt at the first read; the ID is read up to
its first empty register, trailing blanks removed (blanks inside are kept,
shown as "-" in the device id); a unit that gives none (registers missing
or empty) is the device "unit". When another ID is read at the address, another unit may answer
there: its values are not written into the old device, and the mode and the
fan power are refused until **Test the connection** accepts it; it then
becomes a new device in Discovery (the stop never depends on it). An ID
that cannot be read is never taken for another unit, but the commands are
refused.

## What the integration does not do

It never updates the firmware, never changes the settings (but the program:
see the stop and the weekly program above), the schedules or the
temperature asked, never resets the alarms nor acknowledges the
filters, never reads the translations of the web page.
