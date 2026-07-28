import express from 'express';
import cors from 'cors';
import { makeWASocket, DisconnectReason } from '@whiskeysockets/baileys';
import pino from 'pino';
import fs from 'fs';
import dotenv from 'dotenv';
import qrcode from 'qrcode';
import { usePostgresAuthState } from './usePostgresAuthState.js';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3002;
let sock;
let isConnected = false;
let currentQR = null;

let clearDBState = null;

async function connectToWhatsApp() {
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) {
        console.error("Missing DATABASE_URL");
        return;
    }
    
    const { state, saveCreds, clearState } = await usePostgresAuthState(dbUrl);
    clearDBState = clearState;

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        logger: pino({ level: 'silent' }) // suppress verbose logs
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            currentQR = await qrcode.toDataURL(qr);
            console.log('New QR Code generated.');
        }

        if (connection === 'close') {
            isConnected = false;
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed due to', lastDisconnect.error, ', reconnecting:', shouldReconnect);
            if (shouldReconnect) {
                connectToWhatsApp();
            } else {
                console.log('Logged out. Clearing auth from DB to scan new QR.');
                if (clearDBState) await clearDBState();
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            isConnected = true;
            currentQR = null;
            console.log('Opened connection to WhatsApp!');
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type === 'notify') {
            for (const msg of messages) {
                if (!msg.key.fromMe && msg.message) {
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
                }
            }
        }
    });
}

connectToWhatsApp();

// Web UI for QR Code
app.get('/', (req, res) => {
    res.send(`
    <html>
        <head>
            <title>WhatsApp Gateway</title>
            <style>
                body { font-family: sans-serif; text-align: center; background: #222; color: #fff; padding-top: 50px; }
                #qr-container { background: #fff; padding: 20px; border-radius: 10px; display: inline-block; margin-top: 20px; }
                img { width: 300px; height: 300px; }
            </style>
        </head>
        <body>
            <h1>Robô do Clube (WhatsApp)</h1>
            <h2 id="status">Carregando...</h2>
            <div id="qr-container" style="display: none;">
                <img id="qr-image" src="" />
            </div>
            <script>
                async function checkStatus() {
                    try {
                        const res = await fetch('/qr');
                        const data = await res.json();
                        
                        const statusEl = document.getElementById('status');
                        const qrContainer = document.getElementById('qr-container');
                        const qrImage = document.getElementById('qr-image');

                        if (data.status === 'connected') {
                            statusEl.innerText = '✅ Robô Conectado com Sucesso!';
                            statusEl.style.color = '#4CAF50';
                            qrContainer.style.display = 'none';
                        } else if (data.status === 'pending' && data.qr) {
                            statusEl.innerText = '⚠️ Aguardando Leitura do QR Code...';
                            statusEl.style.color = '#FFC107';
                            qrImage.src = data.qr;
                            qrContainer.style.display = 'inline-block';
                        } else {
                            statusEl.innerText = 'Gerando código...';
                            qrContainer.style.display = 'none';
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

app.get('/qr', (req, res) => {
    if (isConnected) {
        return res.json({ status: 'connected', message: 'WhatsApp is already connected.' });
    }
    if (currentQR) {
        return res.json({ status: 'pending', qr: currentQR });
    }
    return res.json({ status: 'initializing', message: 'Generating QR code...' });
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
        const jid = `${to}@s.whatsapp.net`;
        await sock.sendMessage(jid, { text: message });
        res.json({ success: true, message: 'Message sent!' });
    } catch (err) {
        console.error('Failed to send message:', err);
        res.status(500).json({ error: 'Failed to send message.' });
    }
});

app.listen(PORT, () => {
    console.log(`Golf WhatsApp Gateway is running on port ${PORT}`);
});
