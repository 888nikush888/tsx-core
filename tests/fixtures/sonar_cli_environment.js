/** A test subprocess analyzes only its fixture, never its parent CI job's Sonar scope or token. */
export function sonarCliEnvironment(fixture, inherited = process.env) {
  const environment = Object.fromEntries(Object.entries(inherited).filter(([name]) => !name.toUpperCase().startsWith('SONAR_')));
  return { ...environment, ...fixture };
}

export const parentPullRequestEnvironment = {
  SONAR_PULL_REQUEST: '28',
  SONAR_PULL_REQUEST_BRANCH: 'codex/governance-proof-2026-09-07',
  SONAR_PULL_REQUEST_BASE: 'main',
  SONAR_EXPECTED_REVISION: 'cc7d216ee02b65ba53159673f66b12583b1eba88',
  SONAR_REQUIRE_COMPUTE_TASK: 'true',
};
