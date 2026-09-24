import { storageContract } from './contract';
import { memoryAdapter } from './helpers';

storageContract('SQLite (in-memory, real engine)', async () => (await memoryAdapter()).adapter);
