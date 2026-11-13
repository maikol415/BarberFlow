import makeWASocket, { DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import http from 'http';
import fetch from 'node-fetch';

const PORT = process.env.PORT || 3001;
const API_BASE_URL = process.env.BARBERFLOW_API_URL || 'https://barberflow-aos9.onrender.com/api/public';
const BARBERIA_SLUG = process.env.BARBERIA_SLUG || 'barberia-jr';

const ultimaRespuestaHumana = new Map();
const pausaPorIntervencionHumana = new Map();

let ultimoQrDataUrl = '';
let estadoConexion = 'Generando QR...';
let estaConectado = false;

// API REST y Web Server para el Modal del Admin
http.createServer((req, res) => {
  // Encabezados CORS para que el Admin en Render pueda consultar el estado y el QR
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Endpoint JSON para el modal
  if (req.url.startsWith('/api/status')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      conectado: estaConectado,
      estado: estadoConexion,
      qr: ultimoQrDataUrl
    }));
    return;
  }

  // Página embedeable dentro del iframe del modal
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`
    <!DOCTYPE html>
    <html lang="es">
    <head>
      <meta charset="UTF-8">
      <title>QR WhatsApp</title>
      <style>
        body { font-family: sans-serif; background: transparent; color: #111827; display: flex; flex-direction: column; justify-content: center; align-items: center; min-height: 100vh; margin: 0; padding: 10px; text-align: center; }
        .qr-img { width: 230px; height: 230px; border-radius: 12px; margin: 0 auto; display: block; }
        .status { margin-top: 10px; font-weight: bold; color: #059669; font-size: 13px; }
      </style>
      <meta http-equiv="refresh" content="4">
    </head>
    <body>
      ${
        estaConectado 
          ? `<div style="padding:20px;"><h3 style="color:#059669;margin:0;">✅ ¡WhatsApp Conectado!</h3><p style="color:#4B5563;font-size:12px;margin-top:5px;">El bot está activo y listo para responder.</p></div>`
          : ultimoQrDataUrl.startsWith('data:image') 
            ? `<img src="${ultimoQrDataUrl}" class="qr-img" alt="Código QR"><div class="status">${estadoConexion}</div>` 
            : `<div style="padding:30px;color:#6B7280;font-size:13px;">Generando código QR...</div>`
      }
    </body>
    </html>
  `);
}).listen(PORT, () => {
  console.log(`Servidor del Bot y API de estado escuchando en el puerto ${PORT}`);
});

async function iniciarBot() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info_baileys');
  const sock = makeWASocket({ auth: state, printQRInTerminal: false });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      estaConectado = false;
      ultimoQrDataUrl = await QRCode.toDataURL(qr, { width: 280, margin: 2 });
      estadoConexion = 'Apunta con la cámara de WhatsApp';
      console.log('Nuevo QR generado.');
    }

    if (connection === 'close') {
      estaConectado = false;
      const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) {
        estadoConexion = 'Reconectando...';
        iniciarBot();
      } else {
        estadoConexion = 'Sesión cerrada. Escanea de nuevo.';
      }
    } else if (connection === 'open') {
      estaConectado = true;
      ultimoQrDataUrl = '';
      estadoConexion = 'Conectado';
      console.log('¡WhatsApp en línea y conectado!');
    }
  });

  sock.ev.on('messages.upsert', async (m) => {
    const msg = m.messages[0];
    if (!msg.message) return;

    const remitente = msg.key.remoteJid;
    // 🛡️ REGLA 1: Ignorar grupos
    if (!remitente || remitente.includes('@g.us')) return;

    const ahora = Date.now();

    // 🛡️ REGLA 2: Si el barbero escribió personalmente, callar el bot 45 min
    if (msg.key.fromMe) {
      pausaPorIntervencionHumana.set(remitente, ahora + (45 * 60 * 1000));
      return;
    }

    const pausaHasta = pausaPorIntervencionHumana.get(remitente) || 0;
    if (ahora < pausaHasta) return;

    const texto = (
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      ''
    ).toLowerCase().trim();

    if (!texto) return;

    try {
      const res = await fetch(`${API_BASE_URL}/barberia/${BARBERIA_SLUG}`);
      if (!res.ok) return;
      const data = await res.json();
      const barberia = data.barberia || data;

      if (barberia.botActivo === false) return;

      // 1. Preguntas Frecuentes
      const reglas = barberia.botReglas || [];
      for (const regla of reglas) {
        const palabras = regla.palabrasClave.split(',').map(p => p.trim().toLowerCase());
        if (palabras.some(p => p && texto.includes(p))) {
          await sock.sendMessage(remitente, { text: regla.respuesta });
          return;
        }
      }

      // 2. Saludos / Menú
      if (texto.includes('hola') || texto.includes('buenas') || texto.includes('info') || texto === 'menu' || texto === '1') {
        const bienvenida = (barberia.mensajeBienvenidaBot || '¡Hola! 💈 Bienvenido a {barberia}.')
          .replace('{barberia}', barberia.nombre || 'la barbería');
        const msj = `${bienvenida}\n\n` +
          `1️⃣ *Agendar turno en línea:*\n👉 https://barberflow-aos9.onrender.com/index.html?b=${BARBERIA_SLUG}\n\n` +
          `2️⃣ *Ubicación y Horario:*\n📍 ${barberia.direccion}\n⏰ ${barberia.horarioTexto}\n\n` +
          `¿En qué más te podemos ayudar? ✂️`;
        await sock.sendMessage(remitente, { text: msj });
        return;
      }

      // 3. Precios y Servicios
      if (texto.includes('precio') || texto.includes('costo') || texto.includes('cuanto vale') || texto.includes('servicio') || texto === '2') {
        let lista = `💈 *Precios de ${barberia.nombre}:*\n\n`;
        (barberia.servicios || []).forEach(s => {
          lista += `✂️ *${s.nombre}* - $ ${Number(s.precio).toLocaleString()}\n`;
        });
        lista += `\n📅 *Reserva aquí:* https://barberflow-aos9.onrender.com/index.html?b=${BARBERIA_SLUG}`;
        await sock.sendMessage(remitente, { text: lista });
        return;
      }

      // 🛡️ REGLA 3: Derivación humana máx 1 vez cada 2 horas por persona
      const ultimaVezDerivado = ultimaRespuestaHumana.get(remitente) || 0;
      const dosHorasMs = 2 * 60 * 60 * 1000;

      if (ahora - ultimaVezDerivado > dosHorasMs) {
        const derivacion = barberia.mensajeDerivacionHumana || 
          'He recibido tu mensaje. En este momento el barbero está en servicio con un cliente ✂️💈. Tan pronto termine su turno, te responderá personalmente por este chat. ¡Muchas gracias por tu paciencia!';
        
        await sock.sendMessage(remitente, { text: derivacion });
        ultimaRespuestaHumana.set(remitente, ahora);
      }

    } catch (e) {
      console.error('Error procesando mensaje en bot:', e);
    }
  });
}

iniciarBot();
