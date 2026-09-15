import assert from 'assert';
import { TelegramDeliveryTracker } from '../src/delivery_tracker.js';

async function mixedBatchFailureKeepsPendingRejectionsHandled() {
  const tracker = new TelegramDeliveryTracker(1000);
  const unhandled = [];
  const recordUnhandled = error => unhandled.push(error);
  process.on('unhandledRejection', recordUnhandled);
  try {
    for (const [invalid, expected] of [[{ sending_state: null }, /message without an id/], [{ id: {} }, /invalid message id/]]) {
      await assert.rejects(tracker.waitForResult({ messages: [
        { id: -301, sending_state: { _: 'messageSendingStatePending' } },
        invalid,
      ] }), expected);
      tracker.close('mixed batch cleanup');
    }
    await new Promise(resolve => setImmediate(resolve));
    assert.deepStrictEqual(unhandled, [], 'A malformed batch member must not leave earlier pending delivery rejections unhandled.');
  } finally {
    tracker.close();
    process.removeListener('unhandledRejection', recordUnhandled);
  }
}

async function verifyScalarDeliveryContracts() {
  const tracker = new TelegramDeliveryTracker(1000);
  let coercions = 0;
  const hostile = { [Symbol.toPrimitive]() { coercions += 1; throw new Error('Object coercion executed'); } };
  try {
    for (const id of [{}, [], hostile, true, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      await assert.rejects(tracker.waitForResult({ id }), /invalid message id/);
      assert.strictEqual(tracker.handleUpdate({ _: 'updateMessageSendSucceeded', old_message_id: id, message: { id: 77 } }), false);
      assert.strictEqual(tracker.handleUpdate({ _: 'updateMessageSendFailed', old_message_id: id }), false);
    }
    for (const id of ['', '001', 'aggregate', 0, -12, Number.MAX_SAFE_INTEGER, 123n]) {
      assert.deepStrictEqual(await tracker.waitForResult({ id }), { destinationMessageIds: [String(id)] });
    }
    const pending = tracker.waitForResult({ id: -401, sending_state: { _: 'messageSendingStatePending' } });
    assert.strictEqual(tracker.handleUpdate({ _: 'updateMessageSendSucceeded', old_message_id: -401, message: { id: hostile } }), false);
    assert.strictEqual(tracker.handleUpdate({ _: 'updateMessageSendSucceeded', old_message_id: -401, message: { id: null } }), true);
    assert.deepStrictEqual(await pending, { destinationMessageIds: ['-401'] }, 'Malformed success must not consume waiter; null destination retains old ID fallback.');
    for (const detail of [hostile, {}, [], 42, false, '']) {
      await assert.rejects(tracker.waitForResult({ id: 17, sending_state: { _: 'messageSendingStateFailed', error: { message: detail } } }),
        error => error.message === 'Telegram reported a failed sending state.');
      const failed = tracker.waitForResult({ id: -402, sending_state: { _: 'messageSendingStatePending' } });
      tracker.handleUpdate({ _: 'updateMessageSendFailed', old_message_id: -402, error: { message: detail }, message: { sending_state: { error: { message: 'nested failure' } } } });
      await assert.rejects(failed, /nested failure/);
    }
    for (const detail of ['direct failure', '   ']) {
      await assert.rejects(tracker.waitForResult({ id: 18, sending_state: { _: 'messageSendingStateFailed', error: { message: detail } } }), error => error.message === detail);
      const failed = tracker.waitForResult({ id: -403, sending_state: { _: 'messageSendingStatePending' } });
      tracker.handleUpdate({ _: 'updateMessageSendFailed', old_message_id: -403, error: { message: detail }, message: { sending_state: { error: { message: 'nested' } } } });
      await assert.rejects(failed, error => error.message === `Telegram delivery failed for local message -403: ${detail}`);
    }
    const failed = tracker.waitForResult({ id: -404, sending_state: { _: 'messageSendingStatePending' } });
    tracker.handleUpdate({ _: 'updateMessageSendFailed', old_message_id: -404, error: { message: hostile }, message: { sending_state: { error: { message: hostile } } } });
    await assert.rejects(failed, /Telegram send failed\./);
    assert.strictEqual(coercions, 0, 'Identity and diagnostic validation must never invoke foreign coercion.');
  } finally {
    tracker.close();
  }
}

async function runTests() {
  await mixedBatchFailureKeepsPendingRejectionsHandled();
  await verifyScalarDeliveryContracts();
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
