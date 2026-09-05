import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTVerifyGetKey
} from 'jose';
import { enterpriseMode } from './runtime_profile.js';

export type DashboardRole = 'viewer' | 'admin';
type AuthorizationHeader = string | string[] | undefined;
type RequestHeaders = Record<string, string | string[] | undefined>;

export interface AuthenticatedActor {
  role: DashboardRole;
  id: string;
  identity?: {
    provider: 'tailscale';
    login: string;
    name: string | null;
  };
}

export interface DashboardAuthenticator {
  readonly mode: 'token' | 'oidc' | 'tailscale';
  isConfigured(): boolean;
  authenticate(authorization: AuthorizationHeader, headers?: RequestHeaders): Promise<AuthenticatedActor | null>;
  issueLocalAdminSession?(): { token: string; expiresInSeconds: number };
  revokeLocalAdminSessions?(): void;
}

export interface OidcDashboardOptions {
  issuer: string;
  audience: string;
  jwksUrl: string;
  adminRole: string;
  viewerRole: string;
  roleClaim?: string;
  maxTokenAgeSeconds?: number;
  keySet?: JWTVerifyGetKey;
  allowHttpLoopback?: boolean;
}

function bearerToken(authorization: AuthorizationHeader): string | null {
  if (typeof authorization !== 'string' || authorization.length > 16 * 1024) return null;
  return /^Bearer ([^\s]+)$/.exec(authorization)?.[1] ?? null;
}

function safeTokenEquals(candidate: string, expected: string): boolean {
  const candidateBuffer = Buffer.from(candidate);
  const expectedBuffer = Buffer.from(expected);
  return candidateBuffer.length === expectedBuffer.length && timingSafeEqual(candidateBuffer, expectedBuffer);
}

function configuredToken(name: 'DASHBOARD_ADMIN_TOKEN' | 'DASHBOARD_VIEWER_TOKEN'): string | null {
  const value = process.env[name]?.trim() || '';
  if (/^(replace_|change-?me|example|placeholder)/i.test(value)) return null;
  return value.length >= 32 ? value : null;
}

function tokenActorId(token: string): string {
  return `token:${createHash('sha256').update(token).digest('hex').slice(0, 16)}`;
}

export class EnvironmentTokenAuthenticator implements DashboardAuthenticator {
  readonly mode = 'token' as const;
  private readonly localAdminSessions = new Map<string, { expiresAt: number; adminTokenDigest: string }>();

  revokeLocalAdminSessions(): void {
    this.localAdminSessions.clear();
  }

  private localSessionsEnabled(): boolean {
    return process.env.DASHBOARD_LOCAL_TRUST?.trim().toLowerCase() === 'true'
      && process.env.ENTERPRISE_MODE?.trim().toLowerCase() !== 'true';
  }

  issueLocalAdminSession(): { token: string; expiresInSeconds: number } {
    const adminToken = configuredToken('DASHBOARD_ADMIN_TOKEN');
    if (!adminToken || !this.localSessionsEnabled()) {
      this.revokeLocalAdminSessions();
      throw new Error('Local administrator sessions are disabled or no administrator token is configured.');
    }
    const expiresInSeconds = 12 * 60 * 60;
    const now = Date.now();
    for (const [digest, session] of this.localAdminSessions) {
      if (session.expiresAt <= now) this.localAdminSessions.delete(digest);
    }
    while (this.localAdminSessions.size >= 64) {
      const oldest = this.localAdminSessions.keys().next().value;
      if (typeof oldest !== 'string') break;
      this.localAdminSessions.delete(oldest);
    }
    const token = `tsx_local_${randomBytes(32).toString('base64url')}`;
    this.localAdminSessions.set(createHash('sha256').update(token).digest('hex'), {
      expiresAt: now + expiresInSeconds * 1_000,
      adminTokenDigest: createHash('sha256').update(adminToken).digest('hex'),
    });
    return { token, expiresInSeconds };
  }

  isConfigured(): boolean {
    const adminToken = configuredToken('DASHBOARD_ADMIN_TOKEN');
    const viewerToken = configuredToken('DASHBOARD_VIEWER_TOKEN');
    return !!adminToken && (!viewerToken || !safeTokenEquals(adminToken, viewerToken));
  }

  async authenticate(authorization: string | string[] | undefined): Promise<AuthenticatedActor | null> {
    const token = bearerToken(authorization);
    if (!token) return null;
    const id = tokenActorId(token);
    const adminToken = configuredToken('DASHBOARD_ADMIN_TOKEN');
    if (adminToken && safeTokenEquals(token, adminToken)) return { role: 'admin', id };
    const viewerToken = configuredToken('DASHBOARD_VIEWER_TOKEN');
    if (viewerToken && safeTokenEquals(token, viewerToken)) return { role: 'viewer', id };
    const localSessionDigest = createHash('sha256').update(token).digest('hex');
    const localSession = this.localAdminSessions.get(localSessionDigest);
    const currentAdminDigest = adminToken && createHash('sha256').update(adminToken).digest('hex');
    if (localSession && this.localSessionsEnabled() && currentAdminDigest === localSession.adminTokenDigest
      && localSession.expiresAt > Date.now()) {
      return { role: 'admin', id: `local-session:${localSessionDigest.slice(0, 16)}` };
    }
    if (localSession) this.revokeLocalAdminSessions();
    return null;
  }
}

function secureUrl(value: string, name: string, allowHttpLoopback: boolean): URL {
  const url = new URL(value);
  const loopback = ['127.0.0.1', '::1', 'localhost'].includes(url.hostname);
  if (url.username || url.password || url.hash) throw new Error(`${name} must not contain credentials or a fragment.`);
  if (url.protocol !== 'https:' && !(allowHttpLoopback && url.protocol === 'http:' && loopback)) {
    throw new Error(`${name} must use HTTPS.`);
  }
  return url;
}

function configuredIdentifier(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 256 || /[\r\n]/.test(normalized)) throw new Error(`${name} is invalid.`);
  return normalized;
}

function claimRoles(value: unknown): string[] {
  if (typeof value === 'string') return value.split(' ').filter(Boolean);
  if (Array.isArray(value) && value.every(role => typeof role === 'string')) return value;
  return [];
}

export class OidcDashboardAuthenticator implements DashboardAuthenticator {
  readonly mode = 'oidc' as const;
  private readonly issuer: string;
  private readonly audience: string;
  private readonly adminRole: string;
  private readonly viewerRole: string;
  private readonly roleClaim: string;
  private readonly maxTokenAgeSeconds: number;
  private readonly keySet: JWTVerifyGetKey;

  constructor(options: OidcDashboardOptions) {
    const allowHttpLoopback = options.allowHttpLoopback === true;
    secureUrl(options.issuer, 'DASHBOARD_OIDC_ISSUER', allowHttpLoopback);
    this.issuer = configuredIdentifier(options.issuer, 'DASHBOARD_OIDC_ISSUER');
    this.audience = configuredIdentifier(options.audience, 'DASHBOARD_OIDC_AUDIENCE');
    this.adminRole = configuredIdentifier(options.adminRole, 'DASHBOARD_OIDC_ADMIN_ROLE');
    this.viewerRole = configuredIdentifier(options.viewerRole, 'DASHBOARD_OIDC_VIEWER_ROLE');
    this.roleClaim = options.roleClaim?.trim() || 'roles';
    this.maxTokenAgeSeconds = options.maxTokenAgeSeconds ?? 3_600;
    if (this.adminRole === this.viewerRole) throw new Error('OIDC administrator and viewer roles must be different.');
    if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(this.roleClaim)) throw new Error('DASHBOARD_OIDC_ROLE_CLAIM is invalid.');
    if (!Number.isSafeInteger(this.maxTokenAgeSeconds) || this.maxTokenAgeSeconds < 60 || this.maxTokenAgeSeconds > 86_400) {
      throw new Error('DASHBOARD_OIDC_MAX_TOKEN_AGE_SECONDS must be between 60 and 86400.');
    }
    const jwksUrl = secureUrl(options.jwksUrl, 'DASHBOARD_OIDC_JWKS_URL', allowHttpLoopback);
    this.keySet = options.keySet ?? createRemoteJWKSet(jwksUrl, {
      timeoutDuration: 5_000,
      cooldownDuration: 30_000,
      cacheMaxAge: 10 * 60_000
    });
  }

  isConfigured(): boolean {
    return true;
  }

  async authenticate(authorization: string | string[] | undefined): Promise<AuthenticatedActor | null> {
    const token = bearerToken(authorization);
    if (!token) return null;
    try {
      const { payload } = await jwtVerify(token, this.keySet, {
        issuer: this.issuer,
        audience: this.audience,
        algorithms: ['RS256', 'PS256', 'ES256'],
        clockTolerance: 5,
        maxTokenAge: this.maxTokenAgeSeconds
      });
      if (!Number.isSafeInteger(payload.exp) || typeof payload.sub !== 'string' || payload.sub.length < 1 || payload.sub.length > 256) return null;
      const roles = claimRoles(payload[this.roleClaim]);
      let role: DashboardRole | null = null;
      if (roles.includes(this.adminRole)) role = 'admin';
      else if (roles.includes(this.viewerRole)) role = 'viewer';
      if (!role) return null;
      const subject = `${this.issuer}\n${payload.sub}`;
      const id = `oidc:${createHash('sha256').update(subject).digest('hex').slice(0, 32)}`;
      return { role, id };
    } catch {
      return null;
    }
  }
}

function identityUsers(value: string | undefined): Set<string> {
  return new Set((value || '')
    .split(',')
    .map(item => item.trim().toLocaleLowerCase('en-US'))
    .filter(item => /^[^\s,\0]{1,254}$/.test(item)));
}

function singleHeader(headers: RequestHeaders | undefined, name: string): string | null {
  const value = headers?.[name];
  if (typeof value !== 'string' || !value.trim() || value.length > 2_048 || /[\r\n\0]/.test(value)) return null;
  return value.trim();
}

export class TailscaleServeAuthenticator implements DashboardAuthenticator {
  readonly mode = 'tailscale' as const;
  private readonly administrators: Set<string>;
  private readonly viewers: Set<string>;

  constructor(options: { adminUsers: string; viewerUsers?: string }) {
    this.administrators = identityUsers(options.adminUsers);
    this.viewers = identityUsers(options.viewerUsers);
  }

  isConfigured(): boolean {
    return this.administrators.size > 0;
  }

  async authenticate(
    _authorization: AuthorizationHeader,
    headers?: RequestHeaders,
  ): Promise<AuthenticatedActor | null> {
    const loginHeader = singleHeader(headers, 'tailscale-user-login');
    if (!loginHeader) return null;
    const login = loginHeader.toLocaleLowerCase('en-US');
    let role: DashboardRole | null = null;
    if (this.administrators.has(login)) role = 'admin';
    else if (this.viewers.has(login)) role = 'viewer';
    if (!role) return null;
    const name = singleHeader(headers, 'tailscale-user-name');
    return {
      role,
      id: `tailscale:${createHash('sha256').update(login).digest('hex').slice(0, 32)}`,
      identity: { provider: 'tailscale', login, name },
    };
  }
}

function tailscaleAuthenticatorFromEnvironment(): DashboardAuthenticator {
  if (process.env.TAILSCALE_SERVE_TRUSTED_PROXY?.trim().toLowerCase() !== 'true') {
    throw new Error('Tailscale dashboard authentication requires TAILSCALE_SERVE_TRUSTED_PROXY=true.');
  }
  const origin = new URL(process.env.DASHBOARD_ALLOWED_ORIGIN || '');
  if (origin.protocol !== 'https:' || !origin.hostname.endsWith('.ts.net') || origin.pathname !== '/') {
    throw new Error('Tailscale dashboard authentication requires an HTTPS *.ts.net DASHBOARD_ALLOWED_ORIGIN.');
  }
  return new TailscaleServeAuthenticator({
    adminUsers: process.env.TAILSCALE_ADMIN_USERS || '',
    viewerUsers: process.env.TAILSCALE_VIEWER_USERS || '',
  });
}

function oidcAuthenticatorFromEnvironment(): DashboardAuthenticator {
  return new OidcDashboardAuthenticator({
    issuer: process.env.DASHBOARD_OIDC_ISSUER || '',
    audience: process.env.DASHBOARD_OIDC_AUDIENCE || '',
    jwksUrl: process.env.DASHBOARD_OIDC_JWKS_URL || '',
    adminRole: process.env.DASHBOARD_OIDC_ADMIN_ROLE || 'forwarder-admin',
    viewerRole: process.env.DASHBOARD_OIDC_VIEWER_ROLE || 'forwarder-viewer',
    roleClaim: process.env.DASHBOARD_OIDC_ROLE_CLAIM || 'roles',
    maxTokenAgeSeconds: Number(process.env.DASHBOARD_OIDC_MAX_TOKEN_AGE_SECONDS || 3_600),
  });
}

export function dashboardAuthenticatorFromEnvironment(): DashboardAuthenticator {
  const defaultMode = enterpriseMode() ? 'oidc' : 'token';
  const mode = process.env.DASHBOARD_AUTH_MODE?.trim().toLowerCase() || defaultMode;
  if (mode === 'token') return new EnvironmentTokenAuthenticator();
  if (mode === 'tailscale') return tailscaleAuthenticatorFromEnvironment();
  if (mode !== 'oidc') throw new Error('DASHBOARD_AUTH_MODE must be token, oidc or tailscale.');
  return oidcAuthenticatorFromEnvironment();
}
