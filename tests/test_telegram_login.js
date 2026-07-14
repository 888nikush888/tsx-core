import assert from 'node:assert/strict';
import { TelegramLoginCoordinator } from '../src/telegram_login.js';

const coordinator = new TelegramLoginCoordinator();
const login = coordinator.loginDetails();

coordinator.begin();
const phonePromise = login.getPhoneNumber();
assert.equal(coordinator.snapshot().prompt.kind, 'phoneNumber');
assert.equal(coordinator.snapshot().prompt.value, undefined, 'Status must not expose submitted values');
assert.throws(() => coordinator.submit({ value: 'not-a-phone' }), /international digits/);
coordinator.submit({ value: '+491701234567' });
assert.equal(await phonePromise, '+491701234567');
assert.equal(coordinator.snapshot().state, 'authenticating');

const codePromise = login.getAuthCode(true);
assert.equal(coordinator.snapshot().prompt.retry, true);
coordinator.submit({ value: '12345' });
assert.equal(await codePromise, '12345');
assert.equal(JSON.stringify(coordinator.snapshot()).includes('12345'), false, 'Codes must not remain in snapshots');

const passwordPromise = login.getPassword('example hint', false);
assert.equal(coordinator.snapshot().prompt.hint, 'example hint');
coordinator.submit({ value: 'test-password' });
assert.equal(await passwordPromise, 'test-password');
assert.equal(JSON.stringify(coordinator.snapshot()).includes('test-password'), false, 'Passwords must not remain in snapshots');

const namePromise = login.getName();
coordinator.submit({ firstName: 'Alice', lastName: 'Example' });
assert.deepEqual(await namePromise, { firstName: 'Alice', lastName: 'Example' });

login.confirmOnAnotherDevice('tg://login?token=one-time');
assert.equal(coordinator.snapshot().prompt.kind, 'otherDeviceConfirmation');
coordinator.submit({});
assert.equal(coordinator.snapshot().state, 'authenticating');

const cancelledPhone = login.getPhoneNumber();
coordinator.cancel();
await assert.rejects(cancelledPhone, /cancelled by operator/);
assert.deepEqual(coordinator.snapshot(), { state: 'idle' });

coordinator.fail();
assert.equal(coordinator.snapshot().state, 'failed');
coordinator.complete();
assert.deepEqual(coordinator.snapshot(), { state: 'completed' });

console.log('Telegram web login coordinator tests passed.');
