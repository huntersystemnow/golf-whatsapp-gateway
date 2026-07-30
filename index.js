import express from 'express';
import cors from 'cors';
import { makeWASocket, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } from '@whiskeysockets/baileys';
import pino from 'pino';
import pg from 'pg';
const { Pool } = pg;
import dotenv from 'dotenv';
import qrcode from 'qrcode';
import { usePostgresAuthState } from './pgAuthState.js';

dotenv.config();

process.on('uncaughtException', (err) => {
    console.error('UNCAUGHT EXCEPTION:', err);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('UNHANDLED REJECTION:', reason);
});

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;
let client;
let isConnected = false;
let currentQR = null;
const logger = pino({ level: 'silent' });

const logs = [];
const originalLog = console.log;
const originalError = console.error;
console.log = function(...args) {
    logs.push({ level: 'info', msg: args.join(' '), time: new Date() });
    if (logs.length > 50) logs.shift();
    originalLog.apply(console, args);
};
console.error = function(...args) {
    logs.push({ level: 'error', msg: args.join(' '), time: new Date() });
    if (logs.length > 50) logs.shift();
    originalError.apply(console, args);
};

app.get('/debug-logs', (req, res) => res.json(logs));

async function connectToWhatsApp() {
    try {
        const dbUrl = process.env.DATABASE_URL;
        if (!dbUrl) {
            console.error("Missing DATABASE_URL");
            return;
        }

        console.log('Connecting to PostgreSQL for Baileys session storage...');
        const pool = new Pool({
            connectionString: dbUrl,
            ssl: { rejectUnauthorized: false }
        });

        const { state, saveCreds } = await usePostgresAuthState(pool, 'golf-bot');
        const { version, isLatest } = await fetchLatestBaileysVersion();
        console.log(`Using wa v${version.join('.')}, isLatest: ${isLatest}`);

        client = makeWASocket({
            version,
            logger,
            printQRInTerminal: false,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger),
            },
            generateHighQualityLinkPreview: true,
        });

        client.ev.on('creds.update', saveCreds);

        client.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr) {
                console.log('New QR Code generated.');
                currentQR = await qrcode.toDataURL(qr);
            }

            if (connection === 'close') {
                isConnected = false;
                currentQR = null;
                const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
                console.log('Connection closed due to', lastDisconnect?.error, 'reconnecting:', shouldReconnect);
                if (shouldReconnect) {
                    setTimeout(connectToWhatsApp, 2000);
                } else {
                    console.log('Logged out. Wiping session not fully implemented here yet, but reconnecting...');
                    setTimeout(connectToWhatsApp, 2000);
                }
            } else if (connection === 'open') {
                console.log('Opened connection to WhatsApp!');
                isConnected = true;
                currentQR = null;
            }
        });

        client.ev.on('messages.upsert', async (m) => {
            const msg = m.messages[0];
            if (!msg.message || msg.key.fromMe) return;

            const from = msg.key.remoteJid.split('@')[0];
            const text = msg.message.conversation || msg.message.extendedTextMessage?.text;

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
        });
    } catch (err) {
        console.error("FATAL ERROR IN CONNECT:", err);
    }
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
        let jid = to;
        if (!jid.includes('@')) {
            jid = `${to}@s.whatsapp.net`;
        }
        await client.sendMessage(jid, { text: message });
        res.json({ success: true, message: 'Message queued to be sent.' });
    } catch (error) {
        console.error('Error sending message:', error);
        res.status(500).json({ error: 'Failed to send message.' });
    }
});

app.get('/', (req, res) => {
    res.send(`
        <html>
            <head>
                <title>WhatsApp Gateway</title>
                <style>
                    body { font-family: sans-serif; text-align: center; margin-top: 50px; background: #222; color: #fff; }
                    #qr-container { margin: 20px auto; padding: 20px; background: white; border-radius: 10px; display: inline-block; }
                    img { max-width: 300px; }
                    .status { font-size: 1.2rem; margin-top: 20px; }
                    .connected { color: #4CAF50; font-weight: bold; }
                    .offline { color: #F44336; font-weight: bold; }
                </style>
            </head>
            <body>
                <h1>Robô do Clube (WhatsApp)</h1>
                <div id="status" class="status">Verificando...</div>
                <div id="qr-container" style="display: none;">
                    <img id="qr-image" src="" alt="QR Code" />
                    <p style="color: #000; font-size: 0.9rem;">Escaneie o QR Code com o seu WhatsApp.</p>
                </div>

                <script>
                    async function checkStatus() {
                        try {
                            const res = await fetch('/qr');
                            if (!res.ok) throw new Error('Gateway Offline');
                            const data = await res.json();
                            
                            const statusDiv = document.getElementById('status');
                            const qrContainer = document.getElementById('qr-container');
                            const qrImage = document.getElementById('qr-image');

                            if (data.status === 'connected') {
                                statusDiv.innerHTML = '<span class="connected">✅ Robô Conectado com Sucesso!</span>';
                                qrContainer.style.display = 'none';
                            } else if (data.status === 'pending' && data.qr) {
                                statusDiv.innerHTML = 'Aguardando Leitura...';
                                qrImage.src = data.qr;
                                qrContainer.style.display = 'inline-block';
                            } else {
                                statusDiv.innerHTML = data.message || 'Inicializando...';
                                qrContainer.style.display = 'none';
                            }
                        } catch (err) {
                            document.getElementById('status').innerHTML = '<span class="offline">Gateway Offline</span>';
                            document.getElementById('qr-container').style.display = 'none';
                        }
                    }

                    checkStatus();
                    setInterval(checkStatus, 3000);
                </script>
            </body>
        </html>
    `);
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Golf WhatsApp Gateway is running on port ${PORT} with Baileys`);
});
