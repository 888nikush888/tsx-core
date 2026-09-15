# Bounded extraction review — 2026-09-13

Scope: pending triage merge, HEAD d47ee41 versus working tree. Read-only review of substantive helper/control-flow differences in src/web_server.ts, src/ui_configuration.ts, src/ui_review_tree.ts, src/ui_effective_parameters.ts, src/ui_change_review.ts and src/ui_workflow_models.ts. Existing root fixes (Accept-Encoding, own-key allowlists, async contracts, explicit redaction projections, effective sizing guards) were preserved and not reopened.

## Concrete remaining contract regressions

1. src/web_server.ts, uiWorkflowObjectsHandler: `query.has('id') && idParam` turns an explicitly empty detail identifier into a list request. Before: `?kind=resources&id=` calls uiWorkflowDetail with an empty string; its id validator rejects, producing HTTP 400. After: invokes uiWorkflowPage, producing HTTP 200 with entries. Restore dispatch based on `idParam !== null`, keeping the existing detail validator authoritative.
2. src/web_server.ts, staticFilePath/serveStatic: collapsing decode failures and forbidden paths into null loses the cause. A valid encoded traversal `/..%2foutside.txt` was HTTP 403 but becomes HTTP 400 simply because its URL contains `%`. A malformed URL `/%ZZ` remains HTTP 400 but its established error text changes from `Invalid URL encoding.` to `Invalid static file path.`. Preserve an explicit error status/message from path resolution.

Reproducer: extraction-contract-repro.cjs extracts actual named handler definitions from git HEAD and the working tree, transpiles them with the local TypeScript compiler, and executes them in isolated contexts with narrow dependency stubs. It demonstrates the before/after branch behavior without starting a server or database. The workflow detail stub implements the exact currently checked-in empty-ID guard from src/ui_workflow_reads.ts. This is a branch-level proof; it is not an end-to-end HTTP test.

Proposed patch: extraction-contract-fixes.patch, not applied. It includes narrowly placed HTTP regressions adjacent to the existing workflow detail missing-ID assertion and static/gzip assertions in tests/test_web_server.js. `git apply --check --ignore-space-change reports/triage-reconciliation/extraction-contract-fixes.patch` passes (working files have CRLF). Root must apply after the currently running full suite, run the affected HTTP tests and renew route handler inventory if its digest changes.

## Remaining scope reviewed

- Configuration helper extraction retains the order of depth checks, atomic replacement, base cloning, protected-key rejection and recursive assignment.
- Effective parameter unit suffix order and source attribution retain their previous behavior after the root's null/undefined and primitive boxing corrections.
- Review redaction helper recursion retains the depth cutoff, string masking, object-key masking and array recursion. The explicit record helper is used on known root records.
- Review-tree high-surrogate expression receives a Unicode flag but is evaluated on one UTF-16 code unit, preserving the cutoff condition.
- Workflow model lifecycle adds an explicit missing-schema error instead of spreading a missing row; no concrete remaining regression established in this scope.

No other concrete regression was established in these six files during this bounded comparison. This is not approval of the whole merge, not evidence of zero scanner findings, and not a replacement for the final tests. No tracked files were changed by this review.
