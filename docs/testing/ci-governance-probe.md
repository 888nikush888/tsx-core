# Temporary governance verification

This disposable pull request intentionally changes an audited build input without
renewing the implementation receipt. Its container/source-binding gate must fail.
The ordinary verification, dependency-review and PR-specific Sonar jobs should run
against their actual PR scope. This is a negative governance test, not a release
candidate, and will be closed and its branch deleted after the checks are observed.

No application behavior, provider account, credentials or deployed data changes.
