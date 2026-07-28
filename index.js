import express from 'express';
import cors from 'cors';
import { makeWASocket, DisconnectReason, fetchLatestBaileysVersion, Browsers } from '@pontalabs/baileys';
import pino from 'pino';
import fs from 'fs';
import dotenv from 'dotenv';
import pg from 'pg';
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
let currentPairingCode = null;

let clearDBState = null;

async function connectToWhatsApp() {
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) {
        console.error("Missing DATABASE_URL");
        return;
    }
    
    const { state, saveCreds, clearState } = await usePostgresAuthState(dbUrl);
    clearDBState = clearState;
    
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`Using WA v${version.join('.')}, isLatest: ${isLatest}`);

    sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        browser: Browsers.macOS('Desktop'),
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
            console.log('Connection closed due to', lastDisconnect.error?.message, ', reconnecting:', shouldReconnect);
            
            // Wait 5 seconds before reconnecting to avoid spamming the server and getting 428 errors
            setTimeout(async () => {
                if (shouldReconnect) {
                    connectToWhatsApp();
                } else {
                    console.log('Logged out. Clearing auth from DB to scan new QR.');
                    if (clearDBState) await clearDBState();
                    connectToWhatsApp();
                }
            }, 5000);
            
        } else if (connection === 'open') {
            isConnected = true;
            currentQR = null;
            currentPairingCode = null;
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

// Endpoint to request a pairing code
app.post('/pair', async (req, res) => {
    if (isConnected) {
        return res.status(400).json({ error: 'WhatsApp is already connected.' });
    }
    const { phone } = req.body;
    if (!phone) {
        return res.status(400).json({ error: 'Phone number is required (e.g. 5511999999999)' });
    }
    try {
        if (!sock.authState.creds.registered) {
            let cleanPhone = phone.replace(/[^0-9]/g, '');
            if (cleanPhone.length === 10 || cleanPhone.length === 11) {
                cleanPhone = '55' + cleanPhone;
            }

            if (!cleanPhone || cleanPhone.length < 10) {
                return res.status(400).json({ error: 'Número de telefone inválido' });
            }

            const code = await sock.requestPairingCode(cleanPhone);
            currentPairingCode = code;
            console.log(`Pairing code generated for ${cleanPhone}: ${code}`);
            return res.json({ success: true, code });
        } else {
            return res.status(400).json({ error: 'Already registered.' });
        }
    } catch (err) {
        console.error('Failed to request pairing code:', err);
        return res.status(500).json({ error: 'Failed to request pairing code: ' + err.message });
    }
});

app.get('/qr', (req, res) => {
    if (isConnected) {
        return res.json({ status: 'connected', message: 'WhatsApp is already connected.' });
    }
    if (currentPairingCode) {
        return res.json({ status: 'pairing', code: currentPairingCode });
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
        const jid = `${to}@s.whatsapp.net`;
        await sock.sendMessage(jid, { text: message });
        res.json({ success: true, message: 'Message sent!' });
    } catch (err) {
        console.error('Failed to send message:', err);
        res.status(500).json({ error: 'Failed to send message.' });
    }
});

// Web UI for QR Code and Pairing Code
app.get('/', (req, res) => {
    res.send(`
    <html>
        <head>
            <title>WhatsApp Gateway</title>
            <style>
                body { font-family: sans-serif; text-align: center; background: #222; color: #fff; padding-top: 50px; }
                .box { background: #fff; color: #333; padding: 20px; border-radius: 10px; display: inline-block; margin-top: 20px; max-width: 400px; }
                img { width: 300px; height: 300px; }
                input { padding: 10px; font-size: 16px; width: 80%; margin-bottom: 10px; text-align: center; }
                button { padding: 10px 20px; font-size: 16px; background: #4CAF50; color: white; border: none; cursor: pointer; border-radius: 5px; }
                .code-display { font-size: 32px; font-weight: bold; letter-spacing: 5px; color: #000; margin: 20px 0; }
            </style>
        </head>
        <body>
            <h1>Robô do Clube (WhatsApp)</h1>
            <h2 id="status">Carregando...</h2>
            
            <div id="content-container" class="box" style="display: none;">
                <!-- QR Code section -->
                <div id="qr-container">
                    <p>Leia o QR Code:</p>
                    <img id="qr-image" src="" />
                    <p><strong>OU</strong></p>
                </div>
                
                <!-- Pairing Code section -->
                <div id="pairing-container">
                    <p>Conecte com Número (Recomendado):</p>
                    <input type="text" id="phone" placeholder="Ex: 5511999999999" />
                    <br/>
                    <button onclick="requestPairing()">Gerar Código</button>
                    <div id="pairing-code" class="code-display" style="display:none;"></div>
                    <p style="font-size: 12px; color: #666;">No WhatsApp do celular vá em Aparelhos Conectados > Conectar com número de telefone.</p>
                </div>
            </div>

            <script>
                async function requestPairing() {
                    const phone = document.getElementById('phone').value;
                    if(!phone) return alert('Digite o número');
                    
                    const btn = document.querySelector('button');
                    btn.innerText = 'Gerando...';
                    
                    try {
                        const res = await fetch('/pair', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ phone })
                        });
                        const data = await res.json();
                        if(data.code) {
                            document.getElementById('pairing-code').style.display = 'block';
                            document.getElementById('pairing-code').innerText = data.code;
                            btn.innerText = 'Código Gerado!';
                        } else {
                            alert(data.error || 'Erro ao gerar código');
                            btn.innerText = 'Gerar Código';
                        }
                    } catch(e) {
                        alert('Erro de conexão');
                        btn.innerText = 'Gerar Código';
                    }
                }

                async function checkStatus() {
                    try {
                        const res = await fetch('/qr');
                        const data = await res.json();
                        
                        const statusEl = document.getElementById('status');
                        const contentContainer = document.getElementById('content-container');
                        const qrContainer = document.getElementById('qr-container');
                        const qrImage = document.getElementById('qr-image');
                        const codeDisplay = document.getElementById('pairing-code');

                        if (data.status === 'connected') {
                            statusEl.innerText = '✅ Robô Conectado com Sucesso!';
                            statusEl.style.color = '#4CAF50';
                            contentContainer.style.display = 'none';
                        } else if (data.status === 'pairing') {
                            statusEl.innerText = '⚠️ Digite este código no WhatsApp do seu celular!';
                            statusEl.style.color = '#FFC107';
                            contentContainer.style.display = 'inline-block';
                            qrContainer.style.display = 'none';
                            codeDisplay.style.display = 'block';
                            codeDisplay.innerText = data.code;
                        } else if (data.status === 'pending' && data.qr) {
                            statusEl.innerText = '⚠️ Aguardando Conexão...';
                            statusEl.style.color = '#FFC107';
                            contentContainer.style.display = 'inline-block';
                            qrContainer.style.display = 'block';
                            qrImage.src = data.qr;
                        } else {
                            statusEl.innerText = 'O robô está tentando conectar. Se não aparecer o QR Code, use o código numérico!';
                            statusEl.style.color = '#fff';
                            contentContainer.style.display = 'inline-block';
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

app.listen(PORT, () => {
    console.log(`Golf WhatsApp Gateway is running on port ${PORT}`);
});
