# DeepSource findings export

Run `node scripts/export_deepsource_findings.js` with `DEEPSOURCE_TOKEN`, or
`DEEPSOURCE_TOKEN_FILE` pointing to a local UTF-8 token file. Do not commit the token.
Create the PAT in DeepSource user settings, Tokens. The documented API requires
authentication even when the repository dashboard is public.

Optional environment variables: `DEEPSOURCE_LOGIN` (default `888nikush888`),
`DEEPSOURCE_REPOSITORY` (default `tsx-core`), and `DEEPSOURCE_EXPECTED_REVISION`
(full commit SHA; rejects a different revision).

The read-only exporter follows all default-branch `issueOccurrences` pages,
checks unique IDs, total counts, stable repository identity/revision, and repeats
the first page after export. GraphQL/HTTP errors, malformed or stalled pagination,
and changing data fail closed with a nonzero exit. Findings are written only after
successful verification into a fresh timestamped directory under ignored
`reports/deepsource`. Terminal output contains counts, revision and report path;
no token or finding descriptions. Raw responses and occurrences remain in the
local report and may contain sensitive source details.

Scope is the documented static issue-occurrence collection. This export does
not prove that all analyzers have completed, and does not cover separate SCA or
AI issue collections. Compare its revision/counts to the completed cloud scan
before asserting a clean result. The API offers no atomic snapshot: stable
revision, counts and first-page verification detect common concurrent changes
but cannot guarantee isolation from every concurrent analyzer update.

Schema sources, verified September 8, 2026:
- https://docs.deepsource.com/docs/developers/api/repository
- https://docs.deepsource.com/docs/developers/api/check
- https://docs.deepsource.com/docs/developers/api/issue
- https://docs.deepsource.com/docs/developers/api/pat

Fixture checks: `node --test tests/test_deepsource_export.js`.
