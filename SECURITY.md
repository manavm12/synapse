# Security Policy

## Supported versions

Security fixes are applied to the current `main` branch and the latest `0.1.x`
development version. Older commits and archived branches are not supported.

## Reporting a vulnerability

Do not disclose vulnerabilities, credentials, queued task content, or local
paths in a normal issue or pull request.

Repository collaborators should open a draft advisory under **Security →
Advisories** and include reproduction steps, impact, and any suggested
mitigation. Anyone without advisory access should contact the repository owner
through an established private channel.

Do not test against data or systems you do not own. Reports will be acknowledged
privately, triaged for severity and affected versions, and fixed before any
coordinated disclosure.

## Security assumptions

Synapse is a local, single-user tool. It does not provide isolation between
hostile operating-system users who can already read or modify the same account.
Queued task text remains untrusted even when it came from another trusted local
tool.
