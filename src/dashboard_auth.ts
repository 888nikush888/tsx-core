import { createHash, timingSafeEqual } from 'node:crypto';
import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTVerifyGetKey
} from 'jose';
import { enterpriseMode } from './runtime_profile.js';

export type DashboardRole = 'viewer' | 'admin';

export interface AuthenticatedActor {
  role: DashboardRole;
  id: string;
}

export interface DashboardAuthenticator {
  readonly mode: 'token' | 'oidc';
  isConfigured(): boolean;
  authenticate(authorization: string | string[] | undefined): Promise<AuthenticatedActor | null>;
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

function bearerToken(authorization: string | string[] | undefined): string | null {
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
      const role = roles.includes(this.adminRole) ? 'admin' : roles.includes(this.viewerRole) ? 'viewer' : null;
      if (!role) return null;
      const id = `oidc:${createHash('sha256').update(`${this.issuer}\n${payload.sub}`).digest('hex').slice(0, 32)}`;
      return { role, id };
    } catch {
      return null;
    }
  }
}

export function dashboardAuthenticatorFromEnvironment(): DashboardAuthenticator {
  const defaultMode = enterpriseMode() ? 'oidc' : 'token';
  const mode = process.env.DASHBOARD_AUTH_MODE?.trim().toLowerCase() || defaultMode;
  if (mode === 'token') return new EnvironmentTokenAuthenticator();
  if (mode !== 'oidc') throw new Error('DASHBOARD_AUTH_MODE must be token or oidc.');
  return new OidcDashboardAuthenticator({
    issuer: process.env.DASHBOARD_OIDC_ISSUER || '',
    audience: process.env.DASHBOARD_OIDC_AUDIENCE || '',
    jwksUrl: process.env.DASHBOARD_OIDC_JWKS_URL || '',
    adminRole: process.env.DASHBOARD_OIDC_ADMIN_ROLE || 'forwarder-admin',
    viewerRole: process.env.DASHBOARD_OIDC_VIEWER_ROLE || 'forwarder-viewer',
    roleClaim: process.env.DASHBOARD_OIDC_ROLE_CLAIM || 'roles',
    maxTokenAgeSeconds: Number(process.env.DASHBOARD_OIDC_MAX_TOKEN_AGE_SECONDS || 3_600)
  });
}
