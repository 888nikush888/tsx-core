import type { BackupDriveMirrorProof, BackupOffsiteProof, BackupProof, BackupRestoreDrillProof, RestoreEligibility } from '../../../../src/ui_contracts';

export type ManagedSecretStatuses = Record<string, {
  configured: boolean;
  editable: boolean;
  source: 'managed' | 'external' | 'missing';
}>;

export interface RecoveryIssue {
  component: string;
  name?: string;
  reason: string;
}

export interface RecoveryObservation {
  active: boolean;
  serverInstanceId: string;
  issues: RecoveryIssue[];
  session?: { role?: 'admin' | 'viewer'; actorId?: string; provider: string };
  availableRepairs: string[];
}

export interface AccessObservation {
  actorId: string;
  role: 'admin' | 'viewer';
  identity: { provider: 'tailscale'; login: string; name: string | null } | null;
  remoteAccess: { provider: string | null; connected: boolean; origin: string | null };
}

export interface OperationsObservation {
  backup?: {
    healthy: boolean;
    offsiteHealthy?: boolean;
    offsiteRequired?: boolean;
    offsiteConfigured?: boolean;
    integrityVerified: BackupProof | null;
    configurationCoherent: BackupProof | null;
    offsiteVerified: BackupOffsiteProof | null;
    driveMirrorVerified?: BackupDriveMirrorProof | null;
    driveMirrorLastError?: string | null;
    driveMirrorHealthy?: boolean;
    driveMirrorRequired?: boolean;
    driveMirrorConfigured?: boolean;
    restoreEligibility: (RestoreEligibility & { artifactSha256: string }) | null;
    restoreDrill: BackupRestoreDrillProof | null;
  } | null;
  audit?: { healthy: boolean } | null;
}
