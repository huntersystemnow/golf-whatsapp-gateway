import { initAuthCreds, BufferJSON } from '@whiskeysockets/baileys';

export const usePostgresAuthState = async (pool, sessionName = 'baileys_session') => {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS whatsapp_sessions (
            id VARCHAR(255) PRIMARY KEY,
            session_data TEXT NOT NULL,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `);

    const writeData = async (data, id) => {
        const textData = JSON.stringify(data, BufferJSON.replacer);
        await pool.query(`
            INSERT INTO whatsapp_sessions (id, session_data, updated_at) 
            VALUES ($1, $2, CURRENT_TIMESTAMP)
            ON CONFLICT (id) 
            DO UPDATE SET session_data = $2, updated_at = CURRENT_TIMESTAMP
        `, [\`\${sessionName}-\${id}\`, textData]);
    };

    const readData = async (id) => {
        const res = await pool.query(\`SELECT session_data FROM whatsapp_sessions WHERE id = $1\`, [\`\${sessionName}-\${id}\`]);
        if (res.rows.length > 0) {
            return JSON.parse(res.rows[0].session_data, BufferJSON.reviver);
        }
        return null;
    };

    const removeData = async (id) => {
        await pool.query(\`DELETE FROM whatsapp_sessions WHERE id = $1\`, [\`\${sessionName}-\${id}\`]);
    };

    const creds = await readData('creds') || initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(ids.map(async (id) => {
                        let value = await readData(\`\${type}-\${id}\`);
                        if (type === 'app-state-sync-key' && value) {
                            value = import('@whiskeysockets/baileys').then(m => m.proto.Message.AppStateSyncKeyData.fromObject(value));
                        }
                        data[id] = value;
                    }));
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category of Object.keys(data)) {
                        for (const id of Object.keys(data[category])) {
                            const value = data[category][id];
                            const key = \`\${category}-\${id}\`;
                            if (value) {
                                tasks.push(writeData(value, key));
                            } else {
                                tasks.push(removeData(key));
                            }
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: () => writeData(creds, 'creds')
    };
};
