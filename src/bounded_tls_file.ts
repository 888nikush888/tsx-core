import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import type { Stats } from 'node:fs';

function isSafePath(file: string, metadata: Stats, maxBytes: number): boolean {
  return metadata.isFile() && !metadata.isSymbolicLink() && metadata.size >= 1
    && metadata.size <= maxBytes && realpathSync.native(file) === file;
}

function isSameBoundedFile(before: Stats, opened: Stats, maxBytes: number): boolean {
  return opened.isFile() && opened.size >= 1 && opened.size <= maxBytes
    && opened.dev === before.dev && opened.ino === before.ino;
}

function readExactFile(descriptor: number, size: number, invalidMessage: string): Buffer {
  const content = Buffer.alloc(size);
  let offset = 0;
  while (offset < content.length) {
    const count = readSync(descriptor, content, offset, content.length - offset, null);
    if (count === 0) throw new Error(invalidMessage);
    offset += count;
  }
  if (readSync(descriptor, Buffer.alloc(1), 0, 1, null) !== 0) throw new Error(invalidMessage);
  return content;
}

export function readBoundedTlsFile(file: string, maxBytes: number, invalidMessage: string): Buffer {
  const before = lstatSync(file);
  if (!isSafePath(file, before, maxBytes)) throw new Error(invalidMessage);
  const noFollowFlag: unknown = Reflect.get(constants, 'O_NOFOLLOW');
  const descriptor = openSync(file, constants.O_RDONLY | (typeof noFollowFlag === 'number' ? noFollowFlag : 0));
  try {
    const opened = fstatSync(descriptor);
    if (!isSameBoundedFile(before, opened, maxBytes)) throw new Error(invalidMessage);
    const content = readExactFile(descriptor, opened.size, invalidMessage);
    const after = fstatSync(descriptor);
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
      throw new Error(invalidMessage);
    }
    return content;
  } finally {
    closeSync(descriptor);
  }
}
