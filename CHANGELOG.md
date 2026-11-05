# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- Atrea heat recovery ventilation (RD5 regulation) through the unit's local
  web page: current mode, program, fan power asked and current, outdoor,
  supply, extract, exhaust, indoor and average outdoor temperatures,
  temperature asked, heating, cooling, filters to change, active alerts and
  warnings and their codes.
- One session kept with the unit; a refused password is not tried again on
  its own after two refusals in a row.
- Commands behind "Allow the commands" (off by default): the mode (among
  those the unit lets be chosen) and the fan power (12 to 100 %); "Stop the
  unit" never depends on the option, is kept until a mode is chosen, is never
  given up while it has not reached the unit, and is sent again after a
  restart when it may not have landed (the guide lists when it can fail).
- "Test the connection" button, docs in English and French, cover image.
