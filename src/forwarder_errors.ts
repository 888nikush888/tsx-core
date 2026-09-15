import { unknownErrorMessage } from './contract_values.js';

/** Error codes classify provider/system failures; object coercion must not supply them. */
export function forwarderErrorCode(error: unknown): string | number | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  return typeof error.code === 'string' || typeof error.code === 'number' ? error.code : undefined;
}

export function isForwardRestrictedError(error: unknown): boolean {
  return /CHAT_FORWARDS_RESTRICTED|MESSAGE_COPY_FORBIDDEN|CONTENT_RESTRICTED/i.test(unknownErrorMessage(error));
}
