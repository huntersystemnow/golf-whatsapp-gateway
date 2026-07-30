import express from 'express';
import cors from 'cors';
import pkg from 'whatsapp-web.js';
const { Client, RemoteAuth } = pkg;
import wwebjsPostgres from 'wwebjs-postgres';
const { PostgresStore } = wwebjsPostgres;
import pg from 'pg';
const { Pool } = pg;
import dotenv from 'dotenv';
import qrcode from 'qrcode';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3002;
let client;
let isConnected = false;
let currentQR = null;

async function connectToWhatsApp() {
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) {
        console.error("Missing DATABASE_URL");
        return;
    }

    console.log('Connecting to PostgreSQL for WhatsApp session storage...');
    const pool = new Pool({
        connectionString: dbUrl,
        ssl: { rejectUnauthorized: false }
    });

    console.log('Dropping old whatsapp_sessions table to force schema update...');
    await pool.query('DROP TABLE IF EXISTS whatsapp_sessions CASCADE;');

    // Initialize PostgresStore
    const store = new PostgresStore({ pool });

    client = new Client({
        authStrategy: new RemoteAuth({
            store: store,
            backupSyncIntervalMs: 60000 // Backup every 1 minute
        }),
        puppeteer: {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        }
    });

    client.on('qr', async (qr) => {
        console.log('New QR Code generated.');
        currentQR = await qrcode.toDataURL(qr);
    });

    client.on('ready', () => {
        console.log('Opened connection to WhatsApp!');
        isConnected = true;
        currentQR = null;
    });

    client.on('disconnected', (reason) => {
        console.log('WhatsApp was disconnected:', reason);
        isConnected = false;
        currentQR = null;
        // The client usually needs to be reinitialized or it automatically destroys itself depending on the reason.
        client.destroy();
        client.initialize();
    });

    client.on('message', async (msg) => {
        if (!msg.fromMe) {
            const from = msg.from.split('@')[0];
            const text = msg.body;
            if (text) {
                console.log(`Received message from ${from}: ${text}`);
                try {
                    const webhookUrl = process.env.WEBHOOK_URL || 'http://localhost:5173/api/webhook/whatsapp';
                    await fetch(webhookUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ from, text })
                    });
                } catch (err) {
                    console.error('Failed to send to webhook:', err);
                }
            }
        }
    });

    client.initialize();
}

connectToWhatsApp();

app.get('/qr', (req, res) => {
    if (isConnected) {
        return res.json({ status: 'connected', message: 'WhatsApp is already connected.' });
    }
    if (currentQR) {
        return res.json({ status: 'pending', qr: currentQR });
    }
    return res.json({ status: 'initializing', message: 'Generating code...' });
});

app.get('/status', (req, res) => {
    res.json({ connected: isConnected });
});

app.post('/send', async (req, res) => {
    if (!isConnected) {
        return res.status(503).json({ error: 'WhatsApp is not connected.' });
    }

    const { to, message } = req.body;
    if (!to || !message) {
        return res.status(400).json({ error: 'Missing "to" or "message" in request body.' });
    }

    try {
        const jid = `${to}@c.us`; // whatsapp-web.js uses @c.us for regular users
        await client.sendMessage(jid, message);
        res.json({ success: true, message: 'Message sent!' });
    } catch (err) {
        console.error('Failed to send message:', err);
        res.status(500).json({ error: 'Failed to send message.' });
    }
});

// Web UI for QR Code
app.get('/', (req, res) => {
    res.send(`
    <html>
        <head>
            <title>WhatsApp Gateway</title>
            <style>
                body { font-family: sans-serif; text-align: center; background: #222; color: #fff; padding-top: 50px; }
                .box { background: #fff; color: #333; padding: 20px; border-radius: 10px; display: inline-block; margin-top: 20px; max-width: 400px; }
                img { width: 300px; height: 300px; }
            </style>
        </head>
        <body>
            <h1>Robô do Clube (WhatsApp)</h1>
            <h2 id="status">Carregando...</h2>
            
            <div id="content-container" class="box" style="display: none;">
                <div id="qr-container">
                    <p>Leia o QR Code:</p>
                    <img id="qr-image" src="" />
                </div>
            </div>

            <script>
                async function checkStatus() {
                    try {
                        const res = await fetch('/qr');
                        const data = await res.json();
                        
                        const statusEl = document.getElementById('status');
                        const contentContainer = document.getElementById('content-container');
                        const qrContainer = document.getElementById('qr-container');
                        const qrImage = document.getElementById('qr-image');

                        if (data.status === 'connected') {
                            statusEl.innerText = '✅ Robô Conectado com Sucesso!';
                            statusEl.style.color = '#4CAF50';
                            contentContainer.style.display = 'none';
                        } else if (data.status === 'pending' && data.qr) {
                            statusEl.innerText = '⚠️ Aponte a câmera do WhatsApp!';
                            statusEl.style.color = '#FFC107';
                            contentContainer.style.display = 'inline-block';
                            qrContainer.style.display = 'block';
                            qrImage.src = data.qr;
                        } else {
                            statusEl.innerText = 'Gerando novo QR Code oficial... Aguarde.';
                            statusEl.style.color = '#fff';
                            contentContainer.style.display = 'none';
                        }
                    } catch (e) {
                        document.getElementById('status').innerText = 'Gateway Offline';
                    }
                }
                
                checkStatus();
                setInterval(checkStatus, 3000);
            </script>
        </body>
    </html>
    `);
});

app.listen(PORT, () => {
    console.log(`Golf WhatsApp Gateway is running on port ${PORT} with whatsapp-web.js`);
});
