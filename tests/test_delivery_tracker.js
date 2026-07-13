import assert from 'assert';
import { TelegramDeliveryTracker } from '../src/delivery_tracker.js';

async function runTests() {
  assert.throws(() => new TelegramDeliveryTracker(0), /positive safe integer/);
  assert.throws(() => new TelegramDeliveryTracker(1.5), /positive safe integer/);
  const tracker = new TelegramDeliveryTracker(50);

  await assert.rejects(tracker.waitForResult({}), /no destination messages/);
  await assert.rejects(
    tracker.waitForResult({ messages: [{ sending_state: null }] }),
    /message without an id/
  );
  await assert.rejects(
    tracker.waitForResult({ id: 99, sending_state: { _: 'messageSendingStateFailed' } }),
    /Telegram reported a failed sending state/
  );

  assert.deepStrictEqual(
    await tracker.waitForResult({ messages: [{ id: 101, sending_state: null }, { id: 102 }] }),
    { destinationMessageIds: ['101', '102'] },
    'Already-confirmed Telegram messages must complete immediately'
  );

  const pending = tracker.waitForResult({ id: -201, sending_state: { _: 'messageSendingStatePending' } });
  assert.strictEqual(tracker.handleUpdate({
    _: 'updateMessageSendSucceeded',
    old_message_id: -201,
    message: { id: 201 }
  }), true);
  assert.deepStrictEqual(await pending, { destinationMessageIds: ['201'] });

  tracker.handleUpdate({
    _: 'updateMessageSendSucceeded',
    old_message_id: -202,
    message: { id: 202 }
  });
  assert.deepStrictEqual(
    await tracker.waitForResult({ id: -202, sending_state: { _: 'messageSendingStatePending' } }),
    { destinationMessageIds: ['202'] },
    'A send update arriving before waiter registration must be retained'
  );

  const failed = tracker.waitForResult({ id: -203, sending_state: { _: 'messageSendingStatePending' } });
  tracker.handleUpdate({
    _: 'updateMessageSendFailed',
    old_message_id: -203,
    error: { message: 'peer unavailable' }
  });
  await assert.rejects(failed, /peer unavailable/);

  tracker.handleUpdate({
    _: 'updateMessageSendFailed',
    old_message_id: -206,
    message: { sending_state: { error: { message: 'cached send failure' } } }
  });
  await assert.rejects(
    tracker.waitForResult({ id: -206, sending_state: { _: 'messageSendingStatePending' } }),
    /cached send failure/
  );

  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  await assert.rejects(
    tracker.waitForResult({ id: -207, sending_state: { _: 'messageSendingStatePending' } }, alreadyAborted.signal),
    /confirmation aborted/
  );

  const firstWaiter = tracker.waitForResult({ id: -208, sending_state: { _: 'messageSendingStatePending' } });
  await assert.rejects(
    tracker.waitForResult({ id: -208, sending_state: { _: 'messageSendingStatePending' } }),
    /waiter already exists/
  );
  tracker.close('test close');
  await assert.rejects(firstWaiter, /test close/);

  await assert.rejects(
    tracker.waitForResult({ id: -204, sending_state: { _: 'messageSendingStatePending' } }),
    /confirmation timed out after 50ms/
  );

  const controller = new AbortController();
  const aborted = tracker.waitForResult({ id: -205, sending_state: { _: 'messageSendingStatePending' } }, controller.signal);
  controller.abort();
  await assert.rejects(aborted, /confirmation aborted/);

  assert.strictEqual(tracker.handleUpdate({ _: 'updateConnectionState' }), false);
  tracker.close();
  console.log('ALL DELIVERY CONFIRMATION TESTS PASSED!');
}

await runTests().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
