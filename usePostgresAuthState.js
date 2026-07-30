import pkg from 'pg';
const { Pool } = pkg;
import { BufferJSON, initAuthCreds, proto } from '@whiskeysockets/baileys';

export const usePostgresAuthState = async (connectionString) => {
    const pool = new Pool({
        connectionString,
        ssl: { rejectUnauthorized: false }
    });

    // Create table if not exists
    await pool.query(`
        CREATE TABLE IF NOT EXISTS whatsapp_sessions (
            key VARCHAR(255) PRIMARY KEY,
            data TEXT NOT NULL
        )
    `);

    // In-memory cache to save database bandwidth (Vercel Postgres limits)
    const memoryCache = {}; // { key: data }
    const writeQueue = new Map(); // key -> data (null means delete)

    let isFlushing = false;

    // Flush to DB in a single transaction every 60 seconds
    const flushQueue = async () => {
        if (isFlushing || writeQueue.size === 0) return;
        isFlushing = true;
        
        const entries = Array.from(writeQueue.entries());
        writeQueue.clear();

        try {
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                for (const [key, data] of entries) {
                    if (data === null) {
                        await client.query('DELETE FROM whatsapp_sessions WHERE key = $1', [key]);
                    } else {
                        const str = JSON.stringify(data, BufferJSON.replacer);
                        await client.query(
                            `INSERT INTO whatsapp_sessions (key, data) VALUES ($1, $2)
                             ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data`,
                            [key, str]
                        );
                    }
                }
                await client.query('COMMIT');
                console.log(`[DB Sync] Flushed ${entries.length} keys to Postgres`);
            } catch (err) {
                await client.query('ROLLBACK');
                console.error('Error in batch flush, restoring queue...', err.message);
                for (const [key, data] of entries) {
                    if (!writeQueue.has(key)) writeQueue.set(key, data);
                }
            } finally {
                client.release();
            }
        } catch (error) {
            console.error('Error connecting for flush:', error.message);
        }
        
        isFlushing = false;
    };

    // Run the sync every 60 seconds
    setInterval(flushQueue, 60000);

    // Ensure we flush before exiting if possible
    process.on('SIGTERM', async () => {
        await flushQueue();
        process.exit(0);
    });

    const readData = async (key) => {
        if (memoryCache[key] !== undefined) {
            return memoryCache[key];
        }
        try {
            const res = await pool.query('SELECT data FROM whatsapp_sessions WHERE key = $1', [key]);
            if (res.rows.length > 0) {
                const parsed = JSON.parse(res.rows[0].data, BufferJSON.reviver);
                memoryCache[key] = parsed;
                return parsed;
            }
        } catch (error) {
            console.error('Error reading from DB:', error.message);
        }
        memoryCache[key] = null;
        return null;
    };

    const writeData = (key, data) => {
        memoryCache[key] = data;
        writeQueue.set(key, data);
    };

    const removeData = (key) => {
        memoryCache[key] = null;
        writeQueue.set(key, null);
    };

    // Load creds
    let creds = await readData('creds');
    if (!creds) {
        creds = initAuthCreds();
    }

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(
                        ids.map(async id => {
                            let value = await readData(`${type}-${id}`);
                            if (type === 'app-state-sync-key' && value) {
                                value = proto.Message.AppStateSyncKeyData.fromObject(value);
                            }
                            data[id] = value;
                        })
                    );
                    return data;
                },
                set: async (data) => {
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            if (value) {
                                writeData(key, value);
                            } else {
                                removeData(key);
                            }
                        }
                    }
                }
            }
        },
        saveCreds: () => {
            return writeData('creds', creds);
        },
        clearState: async () => {
            for (const key in memoryCache) delete memoryCache[key];
            writeQueue.clear();
            await pool.query('DELETE FROM whatsapp_sessions');
        }
    };
};
