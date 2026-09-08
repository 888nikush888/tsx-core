# Schema mutation execution budget

The 2026-09-08 CI log recorded 1,814 schema mutants, one test worker,
and a successful initial command run taking 1,534 ms. The outer runner
terminated at exactly 1,200,000 ms, before a mutation report existed.

The initial-run duration gives a serial reference of 46.4 minutes for
1,814 runs. This is an estimate, not a completion prediction: killed
mutants may finish earlier, while surviving or timing-out mutants cost more.
Two workers reduce that reference to 23.2 minutes. The schema shard therefore
uses two workers, a 40-minute outer process budget, and a 50-minute CI job
budget that also accommodates installation and evidence upload. Other shards
retain one worker, a 20-minute process budget, and a 30-minute CI job budget.

The whole `src/signal_schema.ts` remains selected. Both
`tests/test_signal_parser.js` and `tests/test_signal_contract_validation.js`
remain in the command for every mutant. Score thresholds remain 80/70/70;
forced runs still disable incremental evidence reuse. No mutator, assertion,
source range, or test was removed.

Stryker's [configuration documentation](https://stryker-mutator.io/docs/stryker-js/configuration/)
defines worker concurrency and explains that the command runner cannot use
per-test coverage selection. Its per-mutant timeout remains the initial
test duration times the default factor 1.5, plus the unchanged `timeoutMS`
of 10,000 ms and measured overhead. Only the enclosing campaign deadline
increased.

Validation on Node 22.23.2:

- Six complete schema test pairs took 8,656 ms serially and 4,247 ms with two
  concurrent processes. All twelve pairs passed. This local measurement does
  not guarantee the same throughput on CI.
- A real Stryker dry run selected the entire schema file in the isolated
  worktree, instrumented its 1,801 mutants, created two workers, and passed
  the complete initial test command. This worktree's schema revision differs
  from the 1,814-mutant CI revision; no completed mutation score is claimed.
- Mutation-runner regressions check both complete schema test commands,
  full-file source selection, unchanged score and per-mutant timeout,
  force/freshness behavior, per-shard campaign deadlines, fail-fast behavior,
  and the matching CI deadline.

The next complete CI campaign must still finish and satisfy the unchanged
mutation score gate. A timeout or missing report continues to fail the job.
