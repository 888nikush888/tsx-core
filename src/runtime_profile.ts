export function enterpriseMode(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.ENTERPRISE_MODE?.trim().toLowerCase();
  if (value === undefined || value === '') return false;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error('ENTERPRISE_MODE must be true or false.');
}
