import makeWASocket, { DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import http from 'http';
import fetch from 'node-fetch';

const PORT = process.env.PORT || 3001;
const API_BASE_URL = process.env.BARBERFLOW_API_URL || 'https://barberflow-aos9.onrender.com/api/public';
const BARBERIA_SLUG = process.env.BARBERIA_SLUG || 'barberia-jr';

// Control inteligente anti-spam:
// 1. Si el barbero escribe en el chat, el bot se calla en esa conversación durante 45 minutos.
// 2. La derivación humana solo se manda 1 sola vez cada 2 horas por persona para evitar repetición.
const ultimaRespuestaHumana = new Map(); // clienteJid -> timestamp
const pausaPorIntervencionHumana = new Map(); // clienteJid -> timestamp

let ultimoQrDataUrl = '';
let estadoConexion = 'Generando QR...';

http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`
    <!DOCTYPE html>
    <html lang="es">
    <head>
      <meta charset="UTF-8">
      <title>Conectar WhatsApp - BarberFlow</title>
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
        body { font-family: sans-serif; background: #0B0F19; color: white; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; }
        .card { background: #111827; border: 1px solid #1F2937; border-radius: 20px; padding: 25px; max-width: 380px; text-align: center; box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
        .qr-img { width: 260px; height: 260px; border-radius: 12px; margin: 15px auto; display: block; background: white; padding: 10px; }
        h2 { margin: 0; color: #3B82F6; }
        p { color: #9CA3AF; font-size: 13px; line-height: 1.4; }
        .status { margin-top: 10px; font-weight: bold; color: #10B981; font-size: 14px; }
      </style>
      <meta http-equiv="refresh" content="4">
    </head>
    <body>
      <div class="card">
        <h2>💈 BarberFlow Bot</h2>
        <p>Abre WhatsApp en tu teléfono > <strong>Dispositivos vinculados</strong> > <strong>Vincular un dispositivo</strong></p>
        ${
          ultimoQrDataUrl.startsWith('data:image') 
            ? `<img src="${ultimoQrDataUrl}" class="qr-img" alt="QR WhatsApp">` 
            : `<div style="padding:40px;color:#9CA3AF;">${ultimoQrDataUrl || 'Generando código QR...'}</div>`
        }
        <div class="status">${estadoConexion}</div>
      </div>
    </body>
    </html>
  `);
}).listen(PORT, () => {
  console.log(`Visor QR de WhatsApp activo en el puerto ${PORT}`);
});

async function iniciarBot() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info_baileys');
  const sock = makeWASocket({ auth: state, printQRInTerminal: false });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      ultimoQrDataUrl = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
      estadoConexion = '📱 Escanea el QR con la cámara de WhatsApp';
      console.log('Nuevo QR generado.');
    }

    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) {
        estadoConexion = 'Reconectando con WhatsApp...';
        iniciarBot();
      } else {
        estadoConexion = 'Sesión cerrada. Escanea de nuevo.';
      }
    } else if (connection === 'open') {
      ultimoQrDataUrl = '✅ ¡WhatsApp Conectado Exitosamente!';
      estadoConexion = '🟢 Bot en línea protegiendo contra spam';
      console.log('¡Bot conectado y protegido contra spam!');
    }
  });

  sock.ev.on('messages.upsert', async (m) => {
    const msg = m.messages[0];
    if (!msg.message) return;

    const remitente = msg.key.remoteJid;
    if (!remitente || remitente.includes('@g.us')) return; // Ignorar grupos

    const ahora = Date.now();

    // 🛡️ REGLA 1 ANTI-SPAM: Si el mensaje lo envió el propio barbero desde su celular:
    if (msg.key.fromMe) {
      // El barbero está hablando personalmente con el cliente.
      // Silenciar el bot para este cliente durante 45 minutos.
      pausaPorIntervencionHumana.set(remitente, ahora + (45 * 60 * 1000));
      return;
    }

    // Si el barbero intervino recientemente en este chat, el bot NO interrumpe
    const pausaHasta = pausaPorIntervencionHumana.get(remitente) || 0;
    if (ahora < pausaHasta) {
      return; // El barbero está conversando, el bot se queda callado
    }

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

      // 1. REGLAS PERSONALIZADAS (Preguntas Frecuentes: parqueadero, métodos de pago, etc.)
      const reglas = barberia.botReglas || [];
      for (const regla of reglas) {
        const palabras = regla.palabrasClave.split(',').map(p => p.trim().toLowerCase());
        if (palabras.some(p => p && texto.includes(p))) {
          await sock.sendMessage(remitente, { text: regla.respuesta });
          return;
        }
      }

      // 2. SALUDOS O MENÚ PRINCIPAL
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

      // 3. CONSULTA DE PRECIOS Y SERVICIOS
      if (texto.includes('precio') || texto.includes('costo') || texto.includes('cuanto vale') || texto.includes('servicio') || texto === '2') {
        let lista = `💈 *Precios de ${barberia.nombre}:*\n\n`;
        (barberia.servicios || []).forEach(s => {
          lista += `✂️ *${s.nombre}* - $ ${Number(s.precio).toLocaleString()}\n`;
        });
        lista += `\n📅 *Reserva tu turno aquí:* https://barberflow-aos9.onrender.com/index.html?b=${BARBERIA_SLUG}`;
        await sock.sendMessage(remitente, { text: lista });
        return;
      }

      // 🛡️ REGLA 2 ANTI-SPAM (DERIVACIÓN HUMANA INTELIGENTE):
      // Si la persona pregunta algo no reconocido, solo se envía el mensaje 1 SOLA VEZ cada 2 horas
      const ultimaVezDerivado = ultimaRespuestaHumana.get(remitente) || 0;
      const dosHorasMs = 2 * 60 * 60 * 1000;

      if (ahora - ultimaVezDerivado > dosHorasMs) {
        const derivacion = barberia.mensajeDerivacionHumana || 
          'He recibido tu mensaje. En este momento el barbero está en servicio con un cliente ✂️💈. Tan pronto termine su turno, te responderá personalmente por este chat. ¡Muchas gracias por tu paciencia!';
        
        await sock.sendMessage(remitente, { text: derivacion });
        ultimaRespuestaHumana.set(remitente, ahora);
      }
      // Si ya se le envió en las últimas 2 horas, el bot NO vuelve a mandar nada. Cero spam.

    } catch (e) {
      console.error('Error en bot:', e);
    }
  });
}

iniciarBot();
