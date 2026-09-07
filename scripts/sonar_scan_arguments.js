import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { sonarScope } from './sonar_scope.js';

export function sonarScanArguments(environment) {
  if (!/^[a-f0-9]{40}$/u.test(environment.SONAR_EXPECTED_REVISION ?? '')) {
    throw new Error('SONAR_EXPECTED_REVISION must be an exact 40-character SHA.');
  }
  const { pullRequest } = sonarScope(environment);
  // The action parses this fixed string before the scanner resolves environment
  // properties. Ref names never enter either a shell or its argument parser.
  const args = ['-Dsonar.scm.revision=${env.SONAR_EXPECTED_REVISION}'];
  if (pullRequest) args.push(
    '-Dsonar.pullrequest.key=${env.SONAR_PULL_REQUEST}',
    '-Dsonar.pullrequest.branch=${env.SONAR_PULL_REQUEST_BRANCH}',
    '-Dsonar.pullrequest.base=${env.SONAR_PULL_REQUEST_BASE}'
  );
  else if (environment.SONAR_BRANCH) args.push('-Dsonar.branch.name=${env.SONAR_BRANCH}');
  return args.join(' ');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required.');
    await appendFile(process.env.GITHUB_OUTPUT, `args=${sonarScanArguments(process.env)}\n`, 'utf8');
  } catch (error) {
    console.error(`Sonar scan scope rejected: ${error.message}`);
    process.exitCode = 1;
  }
}
