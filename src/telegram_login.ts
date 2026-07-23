import type { LoginUser } from 'tdl';

export type TelegramLoginPromptKind =
  | 'phoneNumber'
  | 'emailAddress'
  | 'emailCode'
  | 'authCode'
  | 'password'
  | 'name'
  | 'otherDeviceConfirmation';

export interface TelegramLoginPrompt {
  kind: TelegramLoginPromptKind;
  label: string;
  hint?: string;
  retry?: boolean;
  link?: string;
}

export interface TelegramLoginSnapshot {
  state: 'idle' | 'authenticating' | 'waiting' | 'completed' | 'failed';
  prompt?: TelegramLoginPrompt;
  error?: string;
}

type LoginAnswer = string | { firstName: string; lastName?: string };

interface PendingPrompt {
  kind: TelegramLoginPromptKind;
  resolve: (answer: LoginAnswer) => void;
  reject: (error: Error) => void;
}

function singleLine(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string') throw new Error(`${label} is required.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || /[\r\n\0]/.test(normalized)) {
    throw new Error(`${label} is invalid.`);
  }
  return normalized;
}

export class TelegramLoginCoordinator {
  private current: TelegramLoginSnapshot = { state: 'idle' };
  private pending: PendingPrompt | null = null;
  private readonly onChange?: (snapshot: TelegramLoginSnapshot) => void;

  constructor(onChange?: (snapshot: TelegramLoginSnapshot) => void) {
    this.onChange = onChange;
  }

  snapshot(): TelegramLoginSnapshot {
    return structuredClone(this.current);
  }

  begin(): void {
    this.cancelPending('Telegram login restarted.');
    this.update({ state: 'authenticating' });
  }

  complete(): void {
    this.cancelPending('Telegram login completed.');
    this.update({ state: 'completed' });
  }

  fail(): void {
    this.cancelPending('Telegram login failed.');
    this.update({ state: 'failed', error: 'Telegram authentication failed. Check the service logs.' });
  }

  cancel(): void {
    this.cancelPending('Telegram login cancelled by operator.');
    this.update({ state: 'idle' });
  }

  loginDetails(): Partial<LoginUser> {
    return {
      type: 'user',
      getPhoneNumber: (retry = false) => this.requestString({
        kind: 'phoneNumber',
        label: 'Telegram phone number',
        hint: 'Use international format, for example +491701234567.',
        retry,
      }),
      getEmailAddress: () => this.requestString({
        kind: 'emailAddress',
        label: 'Telegram login email',
      }),
      getEmailCode: () => this.requestString({
        kind: 'emailCode',
        label: 'Email verification code',
      }),
      getAuthCode: (retry = false) => this.requestString({
        kind: 'authCode',
        label: 'Telegram verification code',
        retry,
      }),
      getPassword: (passwordHint, retry = false) => this.requestString({
        kind: 'password',
        label: 'Telegram two-step verification password',
        hint: passwordHint || undefined,
        retry,
      }),
      getName: () => this.requestName(),
      confirmOnAnotherDevice: (link) => {
        this.cancelPending('Telegram requested confirmation on another device.');
        if (!/^tg:\/\/login\?token=[A-Za-z0-9_-]{1,2048}$/.test(link)) {
          this.update({ state: 'failed', error: 'Telegram returned an invalid confirmation link.' });
          return;
        }
        this.update({
          state: 'waiting',
          prompt: {
            kind: 'otherDeviceConfirmation',
            label: 'Confirm this login in Telegram',
            hint: 'Open the link or approve the login on another signed-in device.',
            link,
          },
        });
      },
    };
  }

  submit(payload: unknown): TelegramLoginSnapshot {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('Telegram login response must be an object.');
    }
    const input = payload as Record<string, unknown>;
    const prompt = this.current.prompt;
    if (!prompt) throw new Error('Telegram is not waiting for a login response.');
    if (prompt.kind === 'otherDeviceConfirmation') {
      this.update({ state: 'authenticating' });
      return this.snapshot();
    }
    if (this.pending?.kind !== prompt.kind) {
      throw new Error('Telegram login prompt is no longer active.');
    }
    const answer = prompt.kind === 'name'
      ? this.validateName(input)
      : this.validateString(prompt.kind, input.value);
    const pending = this.pending;
    this.pending = null;
    this.update({ state: 'authenticating' });
    pending.resolve(answer);
    return this.snapshot();
  }

  private validateString(kind: TelegramLoginPromptKind, value: unknown): string {
    if (kind === 'phoneNumber') {
      const phone = singleLine(value, 'Phone number', 20);
      if (!/^\+?\d{5,15}$/.test(phone)) throw new Error('Phone number must use international digits.');
      return phone;
    }
    if (kind === 'emailAddress') {
      const email = singleLine(value, 'Email address', 254);
      const at = email.indexOf('@');
      const domain = email.slice(at + 1);
      const invalidWhitespace = [...email].some(character => character.trim() === '');
      if (at < 1 || at !== email.lastIndexOf('@') || invalidWhitespace || !domain.includes('.') || domain.startsWith('.') || domain.endsWith('.')) {
        throw new Error('Email address is invalid.');
      }
      return email;
    }
    if (kind === 'password') return singleLine(value, 'Two-step verification password', 256);
    return singleLine(value, 'Verification code', 32);
  }

  private validateName(input: Record<string, unknown>): { firstName: string; lastName?: string } {
    const firstName = singleLine(input.firstName, 'First name', 64);
    if (input.lastName === undefined || input.lastName === '') return { firstName };
    return { firstName, lastName: singleLine(input.lastName, 'Last name', 64) };
  }

  private requestString(prompt: TelegramLoginPrompt): Promise<string> {
    return this.request(prompt) as Promise<string>;
  }

  private requestName(): Promise<{ firstName: string; lastName?: string }> {
    return this.request({ kind: 'name', label: 'Telegram account name' }) as Promise<{
      firstName: string;
      lastName?: string;
    }>;
  }

  private request(prompt: TelegramLoginPrompt): Promise<LoginAnswer> {
    if (this.pending) throw new Error('Telegram requested overlapping login input.');
    return new Promise<LoginAnswer>((resolve, reject) => {
      this.pending = { kind: prompt.kind, resolve, reject };
      this.update({ state: 'waiting', prompt });
    });
  }

  private cancelPending(reason: string): void {
    const pending = this.pending;
    this.pending = null;
    pending?.reject(new Error(reason));
  }

  private update(snapshot: TelegramLoginSnapshot): void {
    this.current = snapshot;
    this.onChange?.(this.snapshot());
  }
}
