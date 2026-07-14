import assert from 'node:assert/strict';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import {
  dashboardAuthenticatorFromEnvironment,
  EnvironmentTokenAuthenticator,
  OidcDashboardAuthenticator
} from '../src/dashboard_auth.js';

const ADMIN_TOKEN = 'admin-token-0123456789abcdef0123456789abcdef';
const VIEWER_TOKEN = 'viewer-token-0123456789abcdef0123456789abcdef';
const savedEnvironment = { ...process.env };

try {
  process.env.DASHBOARD_ADMIN_TOKEN = ADMIN_TOKEN;
  process.env.DASHBOARD_VIEWER_TOKEN = VIEWER_TOKEN;
  const tokenAuthenticator = new EnvironmentTokenAuthenticator();
  assert.equal(tokenAuthenticator.isConfigured(), true);
  assert.deepEqual((await tokenAuthenticator.authenticate(`Bearer ${ADMIN_TOKEN}`))?.role, 'admin');
  assert.deepEqual((await tokenAuthenticator.authenticate(`Bearer ${VIEWER_TOKEN}`))?.role, 'viewer');
  assert.equal(await tokenAuthenticator.authenticate('Bearer invalid'), null);
  process.env.DASHBOARD_VIEWER_TOKEN = ADMIN_TOKEN;
  assert.equal(tokenAuthenticator.isConfigured(), false, 'Shared admin/viewer credentials must fail closed.');

  const issuer = 'https://identity.example.com';
  const audience = 'telegram-forwarder';
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = 'test-key';
  publicJwk.alg = 'RS256';
  const authenticator = new OidcDashboardAuthenticator({
    issuer,
    audience,
    jwksUrl: `${issuer}/jwks.json`,
    adminRole: 'forwarder-admin',
    viewerRole: 'forwarder-viewer',
    keySet: createLocalJWKSet({ keys: [publicJwk] })
  });
  const sign = roles => new SignJWT({ roles })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject('engineer-123')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
  const admin = await authenticator.authenticate(`Bearer ${await sign(['forwarder-admin'])}`);
  assert.equal(admin?.role, 'admin');
  assert.match(admin?.id || '', /^oidc:[a-f0-9]{32}$/);
  assert.equal((await authenticator.authenticate(`Bearer ${await sign(['forwarder-viewer'])}`))?.role, 'viewer');
  assert.equal(await authenticator.authenticate(`Bearer ${await sign(['unrelated'])}`), null);

  const wrongAudience = await new SignJWT({ roles: ['forwarder-admin'] })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(issuer)
    .setAudience('different-service')
    .setSubject('engineer-123')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
  assert.equal(await authenticator.authenticate(`Bearer ${wrongAudience}`), null, 'Audience mismatch must fail closed.');

  const missingExpiry = await new SignJWT({ roles: ['forwarder-admin'] })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject('engineer-123')
    .setIssuedAt()
    .sign(privateKey);
  assert.equal(await authenticator.authenticate(`Bearer ${missingExpiry}`), null, 'Tokens without an expiry must fail closed.');

  process.env = { ...savedEnvironment, NODE_ENV: 'production' };
  delete process.env.DASHBOARD_AUTH_MODE;
  delete process.env.DASHBOARD_OIDC_ISSUER;
  assert.throws(() => dashboardAuthenticatorFromEnvironment(), /Invalid URL|OIDC_ISSUER/, 'Production must default to configured OIDC.');

  console.log('Dashboard token and OIDC authentication tests passed.');
} finally {
  process.env = savedEnvironment;
}
