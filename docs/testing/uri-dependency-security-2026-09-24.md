# URI dependency remediation and release gate, 2026-09-24

## Scope and decision

The two `uri-js` vulnerabilities, CVE-2026-93690 (non-terminating path
normalization) and CVE-2026-93751 (malformed UTF-8 decoding into ASCII
metacharacters), are release blockers even for Paper/Testnet. Removing or
changing a scanner does not accept these risks or satisfy the release gate.
The original dependency was development-only:
`eslint@10.6.0 -> ajv@6.15.0 -> uri-js@4.4.1`.

The local candidate replaces only Ajv 6's `uri-js` dependency with
`fast-uri@4.2.1` through the root npm override. The lockfile names the actual
package and pins its registry integrity; the `uri-js@4.4.1` artifact and its
`punycode` dependency are absent. Existing independent `fast-uri@3.1.8`
resolution for Ajv 8 is unchanged. This is a package substitution, not an
ignore rule, vulnerability suppression, or local patch to the vulnerable code.

The similarly named `uri-js-replace@1.0.1` was rejected: its published
`removeDotSegments` still has a zero-length regex match on U+2028/U+2029,
which can leave the input unchanged in a loop. Ajv 8 cannot simply be forced
under ESLint's declared Ajv 6 major-version contract.

## Behavioral evidence and remaining gate

`tests/test_uri_dependency_security.js` imports the URI module as Ajv 6 does.
It checks that malformed percent-encoded UTF-8 remains encoded through parse,
normalize and serialize; a bounded child process checks that U+2028 and U+2029
normalization and resolution terminate; and Ajv 6 must still compile and
validate an external `$ref`. Full ESLint, TypeScript, dependency-policy,
license, complexity, lockfile-install and vulnerability checks must also pass.
No release may be declared safe based only on a dependency scanner showing
fewer results.

The same two CVE tests were also run against the original, integrity-pinned
`uri-js@4.4.1` tarball in a disposable, ignored directory. Both failed as
expected: malformed percent encoding changed the normalized URI, while its
direct `unescapeComponent` decoded the advisory's samples to `.` and CRLF;
the line-separator probe timed out in a terminated child process. Against the
installed Ajv 6 alias, both tests passed. The current Ajv 6 resolver source
uses only `parse`, `serialize`, and `resolve` from that package. The candidate
also matched 51 published `uri-js` parse fixtures and 19 serialize fixtures
from `fast-uri@4.2.1`, plus the repository's targeted RFC 3986 references.

This local candidate remains **unreleased and not start-approved** until the
complete test and coverage suite, independent review, and all required
GitHub checks have passed on the final exact source SHA. A staging installation
and rollback/restore checks remain separate release requirements. A new
advisory, dependency drift or failing parser compatibility test blocks the
start again.

Primary upstream reports: [CVE-2026-93690](https://github.com/garycourt/uri-js/issues/105),
[CVE-2026-93751](https://github.com/garycourt/uri-js/issues/106),
and [Fastify fast-uri releases](https://github.com/fastify/fast-uri/releases).
