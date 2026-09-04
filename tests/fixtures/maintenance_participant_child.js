import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { registerDatabaseMaintenanceParticipant } from '../../src/mcp_maintenance.js';

const databasePath = process.argv[2];
const participant = await registerDatabaseMaintenanceParticipant(databasePath);
const database = await open({ filename: databasePath, driver: sqlite3.Database });
await participant.afterOpen();
await database.get('SELECT value FROM proof');
process.send({ state: 'opened', id: participant.id });
setInterval(() => {}, 1000); // The parent deliberately kills this fixture with the native handle open.
