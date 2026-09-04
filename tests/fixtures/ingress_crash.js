import { initDb, getDatabase, withDatabaseTransaction } from '../../src/db.js';
import { acceptIncomingMessage, processIncomingWork, flushIncomingAlbums } from '../../src/incoming_work_repository.js';

const [databasePath, phase] = process.argv.slice(2);
await initDb(databasePath);
const config = { sourceChannels: ['-1001'], filters: {}, forwardOptions: { forwardToTarget: true } };
const message = { id: 100, chat_id: -1001, media_group_id: '0', content: { _: 'messageText', text: { text: 'crash fixture' } } };
if (phase === 'before') process.exit(77);
if (phase === 'inside') {
  await withDatabaseTransaction(async () => {
    await acceptIncomingMessage(message, config);
    process.exit(77);
  });
}
await acceptIncomingMessage(message, config);
if (phase === 'after') process.exit(77);
if (phase === 'fanout') {
  await withDatabaseTransaction(async () => {
    await processIncomingWork();
    process.exit(77);
  });
}
if (phase === 'album') {
  await acceptIncomingMessage({ ...message, id: 101, media_group_id: 'album-crash' }, config);
  await processIncomingWork();
  await withDatabaseTransaction(async () => {
    await flushIncomingAlbums(Date.now() + 5000);
    const row = await getDatabase().get("SELECT status FROM incoming_album_groups WHERE media_group_id = 'album-crash'");
    if (row.status !== 'completed') throw new Error('Album not completed in test transaction.');
    process.exit(77);
  });
}
throw new Error(`Unknown crash phase: ${phase}`);
