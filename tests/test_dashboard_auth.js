import assert from 'node:assert/strict';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import {
  dashboardAuthenticatorFromEnvironment,
  EnvironmentTokenAuthenticator,
  OidcDashboardAuthenticator,
  TailscaleServeAuthenticator,
} from '../src/dashboard_auth.js';

const ADMIN_TOKEN = 'admin-token-0123456789abcdef0123456789abcdef';
const VIEWER_TOKEN = 'viewer-token-0123456789abcdef0123456789abcdef';
const savedEnvironment = { ...process.env };

try {
  process.env.DASHBOARD_ADMIN_TOKEN = ADMIN_TOKEN;
  process.env.DASHBOARD_VIEWER_TOKEN = VIEWER_TOKEN;
  process.env.DASHBOARD_LOCAL_TRUST = 'true';
  const tokenAuthenticator = new EnvironmentTokenAuthenticator();
  assert.equal(tokenAuthenticator.isConfigured(), true);
  assert.deepEqual((await tokenAuthenticator.authenticate(`Bearer ${ADMIN_TOKEN}`))?.role, 'admin');
  assert.deepEqual((await tokenAuthenticator.authenticate(`Bearer ${VIEWER_TOKEN}`))?.role, 'viewer');
  assert.equal(await tokenAuthenticator.authenticate('Bearer invalid'), null);
  const localSession = tokenAuthenticator.issueLocalAdminSession();
  assert.match(localSession.token, /^tsx_local_[A-Za-z0-9_-]{40,}$/);
  assert.equal(localSession.expiresInSeconds, 12 * 60 * 60);
  const localActor = await tokenAuthenticator.authenticate(`Bearer ${localSession.token}`);
  assert.equal(localActor?.role, 'admin');
  assert.match(localActor?.id || '', /^local-session:[a-f0-9]{16}$/);
  process.env.DASHBOARD_ADMIN_TOKEN = 'rotated-admin-token-0123456789abcdef0123456789';
  assert.equal(await tokenAuthenticator.authenticate(`Bearer ${localSession.token}`), null,
    'Rotating the durable administrator token must immediately revoke local sessions.');
  process.env.DASHBOARD_ADMIN_TOKEN = ADMIN_TOKEN;
  const disabledSession = tokenAuthenticator.issueLocalAdminSession();
  process.env.DASHBOARD_LOCAL_TRUST = 'false';
  assert.equal(await tokenAuthenticator.authenticate(`Bearer ${disabledSession.token}`), null,
    'Disabling local trust must immediately revoke local sessions.');
  process.env.DASHBOARD_LOCAL_TRUST = 'true';

  const originalNow = Date.now;
  let currentTime = 1_000_000;
  Date.now = () => currentTime;
  try {
    const expiringAuthenticator = new EnvironmentTokenAuthenticator();
    const expiredDuringAuthentication = expiringAuthenticator.issueLocalAdminSession();
    expiringAuthenticator.issueLocalAdminSession();
    currentTime += expiredDuringAuthentication.expiresInSeconds * 1_000 + 1;
    assert.equal(
      await expiringAuthenticator.authenticate(`Bearer ${expiredDuringAuthentication.token}`),
      null
    );
    const activeSession = expiringAuthenticator.issueLocalAdminSession();
    assert.equal(
      (await expiringAuthenticator.authenticate(`Bearer ${activeSession.token}`))?.role,
      'admin'
    );
    for (let index = 0; index < 65; index += 1) {
      expiringAuthenticator.issueLocalAdminSession();
    }
  } finally {
    Date.now = originalNow;
  }

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
  assert.throws(
    () => new OidcDashboardAuthenticator({
      issuer,
      audience,
      jwksUrl: `${issuer}/jwks.json`,
      adminRole: 'shared-role',
      viewerRole: 'shared-role',
      keySet: createLocalJWKSet({ keys: [publicJwk] })
    }),
    /must be different/
  );
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

  const tailscale = new TailscaleServeAuthenticator({
    adminUsers: 'operator@example.com',
    viewerUsers: 'observer@example.com',
  });
  assert.equal(tailscale.isConfigured(), true);
  const tailscaleAdmin = await tailscale.authenticate(undefined, {
    'tailscale-user-login': 'Operator@Example.com',
    'tailscale-user-name': 'TSX Operator',
  });
  assert.equal(tailscaleAdmin?.role, 'admin');
  assert.equal(tailscaleAdmin?.identity?.login, 'operator@example.com');
  assert.match(tailscaleAdmin?.id || '', /^tailscale:[a-f0-9]{32}$/);
  assert.equal((await tailscale.authenticate(undefined, {
    'tailscale-user-login': 'observer@example.com',
  }))?.role, 'viewer');
  assert.equal(await tailscale.authenticate(undefined, {
    'tailscale-user-login': 'unknown@example.com',
  }), null);
  assert.equal(await tailscale.authenticate(undefined, {
    'tailscale-user-login': ['operator@example.com'],
  }), null, 'Duplicated proxy identity headers must fail closed.');

  process.env = { ...savedEnvironment, NODE_ENV: 'production', ENTERPRISE_MODE: 'true' };
  delete process.env.DASHBOARD_AUTH_MODE;
  delete process.env.DASHBOARD_OIDC_ISSUER;
  assert.throws(() => dashboardAuthenticatorFromEnvironment(), /Invalid URL|OIDC_ISSUER/, 'Enterprise mode must default to configured OIDC.');
  process.env = { ...savedEnvironment, NODE_ENV: 'production', ENTERPRISE_MODE: 'false' };
  delete process.env.DASHBOARD_AUTH_MODE;
  assert.equal(dashboardAuthenticatorFromEnvironment().mode, 'token', 'Standalone Docker must support web bootstrap.');
  process.env.DASHBOARD_AUTH_MODE = 'tailscale';
  process.env.TAILSCALE_SERVE_TRUSTED_PROXY = 'true';
  process.env.DASHBOARD_ALLOWED_ORIGIN = 'https://tsx-core.example-tailnet.ts.net';
  process.env.TAILSCALE_ADMIN_USERS = 'operator@example.com';
  assert.equal(dashboardAuthenticatorFromEnvironment().mode, 'tailscale');
  process.env.TAILSCALE_SERVE_TRUSTED_PROXY = 'false';
  assert.throws(() => dashboardAuthenticatorFromEnvironment(), /TRUSTED_PROXY/);

  console.log('Dashboard token and OIDC authentication tests passed.');
} finally {
  process.env = savedEnvironment;
}
