import { timingSafeEqual } from 'node:crypto';

/** Compares security-relevant strings without content-dependent early exit. */
export function constantTimeStringEqual(expected: string, candidate: unknown): boolean {
  if (typeof candidate !== 'string') return false;
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const candidateBuffer = Buffer.from(candidate, 'utf8');
  return expectedBuffer.length === candidateBuffer.length
    && timingSafeEqual(expectedBuffer, candidateBuffer);
}
