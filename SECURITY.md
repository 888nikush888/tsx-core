# Security Policy

## Supported versions

Security fixes are provided for the latest released `1.x` version only. A release that reaches end of support remains blocked from production deployment.

## Reporting a vulnerability

Use GitHub Private Vulnerability Reporting for this repository. Do not open a public issue, discussion or pull request containing exploit details, credentials, personal data or production identifiers. If private reporting is unavailable, contact the repository owner through the organization's established private security channel and disclose only the minimum information needed to establish a secure exchange.

Include the affected commit/version, entry point, prerequisites, reproducible impact, safe proof of concept and suggested containment. Never test against production accounts, Telegram chats, audit sinks or backup stores without written authorization.

The security owner should acknowledge a report within two business days, establish severity and containment within five business days, and publish a coordinated remediation timeline. Critical data-loss, authorization, secret-exposure or automatic-side-effect vulnerabilities trigger release freeze, credential review, incident response and a mandatory regression test.

## Disclosure and evidence

Fixes must pass the repository Quality OS, security scans, affected contract tests, rollback validation and staging evidence before release. Public disclosure occurs only after supported deployments have a reasonable remediation window and must not expose secrets or personal data.
