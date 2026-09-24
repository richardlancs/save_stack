import { describe, expect, it } from 'vitest';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';

// Guards the assumption the whole storage test strategy rests on: the real engine, with the features
// the schema needs, loads in plain Node so the contract suite does not need a browser.
describe('sqlite-wasm in Node', () => {
  it('opens an in-memory database with FTS5 (porter + unicode61) and contentless_delete', async () => {
    const sqlite3 = await sqlite3InitModule();
    const db = new sqlite3.oo1.DB(':memory:');
    try {
      db.exec(`CREATE VIRTUAL TABLE t USING fts5(a, tokenize = "porter unicode61 remove_diacritics 2", prefix = '2 3')`);
      db.exec(`INSERT INTO t (rowid, a) VALUES (1, 'easy pasta recipes'), (2, 'gym squat routine')`);
      expect(db.selectValues(`SELECT rowid FROM t WHERE t MATCH '"recipe"'`)).toEqual([1]); // stemming
      expect(db.selectValues(`SELECT rowid FROM t WHERE t MATCH '"sq"*'`)).toEqual([2]); // prefix
      expect(db.selectValue('SELECT sqlite_version()')).toMatch(/^3\.\d+/);
      // FTS5 set difference, used by the tiered search design
      expect(db.selectValues(`SELECT rowid FROM t WHERE t MATCH '("pasta" OR "squat") NOT ("squat")'`)).toEqual([1]);
    } finally {
      db.close();
    }
  });
});
