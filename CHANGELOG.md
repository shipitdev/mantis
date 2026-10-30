# Mantis changelog

This records Mantis additions and changes. Pi's package changelogs remain in place.
New changes go under Unreleased, then move to a release section when released.

## [Unreleased]

### Added

- Mantis name, command, and configuration directory on the Pi foundation.
- Optional text delegation, loaded explicitly from the source checkout. The lead
  selects a configured provider and model and can send follow-up tasks to a saved worker.
- Cancellation and worker cleanup on session changes, navigation, reload, and exit.

### Changed

- Application self-update is disabled; update the fork through reviewed upstream releases.
  Extension and model updates remain available.

### Development

- Pinned model-catalog hydration and checks for unexpected changes to upstream files.
- Checks for Mantis changes and a manual report for reviewing an upstream Pi candidate.

### Current limits

- Delegation supports one active, text-only worker at a time.
- A saved worker handle cannot automatically resume after its worker is released.
- The extension is available from the source checkout; there is no packaged release yet.
