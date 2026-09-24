import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import { Readable } from 'node:stream';

const ENCRYPTED_MAGIC = Buffer.from('TGFE1\0', 'ascii');
const MAX_OBJECT_BYTES = 8 * 1024 ** 3;
const DRIVE_API = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';

export interface DriveMirrorReceipt {
  objectName: string;
  driveFileId: string;
  sha256: string;
  size: number;
  verifiedAt: number;
  reused: boolean;
}

interface DriveMirrorOptions {
  folderId: string;
  accessToken: () => Promise<string>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface DriveFile {
  id: string;
  name: string;
}

function assertDriveFile(value: unknown, name: string): DriveFile {
  if (!value || typeof value !== 'object') throw new Error('Drive returned invalid file metadata.');
  const file = value as Record<string, unknown>;
  if (typeof file.id !== 'string' || !/^[A-Za-z0-9_-]{10,256}$/.test(file.id) || file.name !== name) {
    throw new Error('Drive returned unexpected file identity.');
  }
  return { id: file.id, name };
}

async function hashFile(filePath: string): Promise<string> {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) digest.update(chunk);
  return digest.digest('hex');
}

/** A secondary copy only. Drive has no compliance-mode retention receipt. */
export class GoogleDriveBackupMirror {
  private readonly request: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: DriveMirrorOptions) {
    if (!/^[A-Za-z0-9_-]{10,256}$/.test(options.folderId)) throw new Error('Drive mirror folder ID is invalid.');
    this.request = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1_000 || this.timeoutMs > 15 * 60_000) {
      throw new Error('Drive mirror timeout must be between 1 second and 15 minutes.');
    }
  }

  private async token(): Promise<string> {
    const value = await this.options.accessToken();
    if (!value || /[\r\n]/.test(value)) throw new Error('Drive mirror access token is invalid.');
    return value;
  }

  private async existingFile(name: string, token: string): Promise<DriveFile | null> {
    const query = `'${this.options.folderId}' in parents and name = '${name}' and trashed = false`;
    const url = new URL(DRIVE_API);
    url.searchParams.set('q', query);
    url.searchParams.set('fields', 'nextPageToken,files(id,name)');
    url.searchParams.set('pageSize', '2');
    const response = await this.request(url, {
      headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs)
    });
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new Error(`Drive mirror lookup failed with HTTP ${response.status}.`);
    }
    const result = await response.json() as { files?: unknown[]; nextPageToken?: string };
    if (!Array.isArray(result.files) || result.files.length > 1 || result.nextPageToken) {
      throw new Error('Drive mirror contains ambiguous duplicate object names.');
    }
    return result.files.length ? assertDriveFile(result.files[0], name) : null;
  }

  private async createFile(filePath: string, name: string, size: number, token: string): Promise<DriveFile> {
    const metadata = { name, parents: [this.options.folderId], mimeType: 'application/octet-stream' };
    const initialize = await this.request(`${DRIVE_UPLOAD}?uploadType=resumable&fields=id,name`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs),
      headers: {
        Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': 'application/octet-stream', 'X-Upload-Content-Length': String(size)
      },
      body: JSON.stringify(metadata)
    });
    const location = initialize.headers.get('location');
    await initialize.body?.cancel();
    if (initialize.status !== 200 || !location) throw new Error(`Drive mirror upload initialization failed with HTTP ${initialize.status}.`);
    const session = new URL(location);
    if (session.origin !== 'https://www.googleapis.com' || !session.pathname.startsWith('/upload/drive/v3/files')) {
      throw new Error('Drive mirror returned an untrusted upload session URL.');
    }
    const upload = await this.request(session, {
      method: 'PUT', redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream', 'Content-Length': String(size) },
      body: createReadStream(filePath), duplex: 'half'
    } as unknown as RequestInit & { duplex: 'half' });
    if (upload.status !== 200 && upload.status !== 201) {
      await upload.body?.cancel();
      throw new Error(`Drive mirror upload failed with HTTP ${upload.status}.`);
    }
    return assertDriveFile(await upload.json(), name);
  }

  private async verifyFile(id: string, size: number, expectedSha256: string, token: string): Promise<void> {
    const response = await this.request(`${DRIVE_API}/${encodeURIComponent(id)}?alt=media`, {
      headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs)
    });
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel();
      throw new Error(`Drive mirror verification download failed with HTTP ${response.status}.`);
    }
    let received = 0;
    const digest = createHash('sha256');
    for await (const chunk of Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])) {
      received += chunk.length;
      if (received > size) throw new Error('Drive mirror verification exceeded expected object size.');
      digest.update(chunk);
    }
    if (received !== size || digest.digest('hex') !== expectedSha256) {
      throw new Error('Drive mirror verification did not match encrypted source bytes.');
    }
  }

  async mirror(filePath: string, objectName: string, expectedSha256: string): Promise<DriveMirrorReceipt> {
    if (!/^backup-\d{4}-[a-zA-Z0-9_.:-]{1,160}\.tgfb$/.test(objectName)) throw new Error('Drive mirror object name is invalid.');
    if (!/^[a-f0-9]{64}$/.test(expectedSha256)) throw new Error('Drive mirror source SHA-256 is invalid.');
    const file = await fs.open(filePath, 'r');
    let size: number;
    try {
      const stats = await file.stat();
      size = stats.size;
      if (!stats.isFile() || size < ENCRYPTED_MAGIC.length + 12 + 16 + 1 || size > MAX_OBJECT_BYTES) {
        throw new Error('Drive mirror source is not a bounded encrypted backup file.');
      }
      const header = Buffer.alloc(ENCRYPTED_MAGIC.length);
      const { bytesRead } = await file.read(header, 0, header.length, 0);
      if (bytesRead !== header.length || !header.equals(ENCRYPTED_MAGIC)) {
        throw new Error('Drive mirror refuses a source without the encrypted backup header.');
      }
    } finally {
      await file.close();
    }
    if (await hashFile(filePath) !== expectedSha256) throw new Error('Drive mirror source SHA-256 does not match.');
    const token = await this.token();
    const existing = await this.existingFile(objectName, token);
    const remote = existing ?? await this.createFile(filePath, objectName, size, token);
    await this.verifyFile(remote.id, size, expectedSha256, token);
    return { objectName, driveFileId: remote.id, sha256: expectedSha256, size, verifiedAt: Date.now(), reused: Boolean(existing) };
  }
}
