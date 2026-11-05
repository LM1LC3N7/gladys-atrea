# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`). It
contains logic ported to JavaScript from the two projects below. The ported
parts were rewritten, not copied; the changes are described below.

## pyatrea

<https://github.com/JurajNyiri/pyatrea> (Python library for Atrea ventilation
units, version 0.10.0, commit 710ffc2 of 2026-07-27), by Juraj Nyíri. MIT
License; its LICENSE file was left as the template with its placeholders
("[year] [fullname]"), quoted as is below.

Ported in `src/constants.js`, `src/atrea/protocol.js` and `src/app.js`: the
pages of the unit's web interface (`config/login.cgi?magic=`, with the md5 of
CR LF and the password; `config/xml.xml`; `user/params.xml`;
`config/xml.cgi` with `<register><five digits>` writes), the `auth=<code>`
session and the two random letters of each request, the "HTTP: 403
Forbidden" page that asks for a session, the "denied" answer, the registers
`<O I= V=>` of the RD5 regulation: H10705 (current mode, AtreaMode 0 to 19),
H10700 to H10703 (program: manual, weekly, temporary), H10709 (mode written),
H10708 (fan power written, 12 to 100), H10714 and H10704 (fan power asked and
current), H10706 (temperature asked), H10712 (forced mode), I12004 and H11700
(the writable modes), I00020 to I00022 (version), H12300 to H12309 (unit ID),
the W and A flags of the metadata page; the program writes of a mode change
(temporary under the weekly program) and of the manual program.

Changed: the HTTP client is the integration's own (one HTTP/1.0 request at a
time on its own connection, bounded answers, no `requests`, no User-Agent);
one session kept and a sign-in only on the "403" page, never in a loop; the
old RD4 registers (H01000 and the like), the `lang/` and `cfgdir.xml` pages
(translations, model) and the one-shot commands are not used.

```
MIT License

Copyright (c) [year] [fullname]

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## HomeAssistant-Atrea

<https://github.com/JurajNyiri/HomeAssistant-Atrea> (Home Assistant custom
integration for Atrea units, version 6.2.0, commit 57c5ef0 of 2026-10-19), by
Juraj Nyíri. Licensed under the Apache License, Version 2.0 (the same license
as this integration, full text in `LICENSE`).

Ported in `src/constants.js`, `src/atrea/protocol.js` and `src/devices.js`:
the sensors it reads (I10211 to I10215 and I11420 temperatures as signed
16-bit tenths of a degree; C10215 and C10216 heating and cooling; D11183, the
filter warning), the fan power shown as a percentage, the stop as manual
program and mode off, and the 10 to 40 °C bounds of the temperature asked.

Changed: the device, its features and the commands are the integration's own
(no climate entity: a mode list, a fan power and a stop button); the alarm
reset and filter acknowledgement buttons, the IN1/IN2/SA1 sensors, the air
flows and the D1-D4 inputs are not used.
