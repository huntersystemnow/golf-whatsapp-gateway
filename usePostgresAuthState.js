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

    const readData = async (key) => {
        try {
            const res = await pool.query('SELECT data FROM whatsapp_sessions WHERE key = $1', [key]);
            if (res.rows.length > 0) {
                return JSON.parse(res.rows[0].data, BufferJSON.reviver);
            }
        } catch (error) {
            console.error('Error reading from DB:', error.message);
        }
        return null;
    };

    const writeData = async (key, data) => {
        try {
            const str = JSON.stringify(data, BufferJSON.replacer);
            await pool.query(
                `INSERT INTO whatsapp_sessions (key, data) VALUES ($1, $2)
                 ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data`,
                [key, str]
            );
        } catch (error) {
            console.error('Error writing to DB:', error.message);
        }
    };

    const removeData = async (key) => {
        try {
            await pool.query('DELETE FROM whatsapp_sessions WHERE key = $1', [key]);
        } catch (error) {
            console.error('Error removing from DB:', error.message);
        }
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
                    const tasks = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            if (value) {
                                tasks.push(writeData(key, value));
                            } else {
                                tasks.push(removeData(key));
                            }
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: () => {
            return writeData('creds', creds);
        },
        clearState: async () => {
            await pool.query('DELETE FROM whatsapp_sessions');
        }
    };
};
