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

    console.log(`[Mensaje Recibido] De: ${remitente} | fromMe: ${msg.key.fromMe}`);

    const ahora = Date.now();

    // 🛡️ REGLA 2: Si el barbero escribió personalmente, callar el bot 45 min
    if (msg.key.fromMe) {
      console.log(`[Anti-Spam] Barbero respondió manualmente a ${remitente}. Silenciando bot 45 min para este contacto.`);
      pausaPorIntervencionHumana.set(remitente, ahora + (45 * 60 * 1000));
      return;
    }

    const pausaHasta = pausaPorIntervencionHumana.get(remitente) || 0;
    if (ahora < pausaHasta) {
      console.log(`[Anti-Spam] Contacto ${remitente} en pausa por intervención humana activa.`);
      return;
    }

    // Extraer texto de cualquier formato de mensaje (conversación directa, respuesta extendida, pie de foto, etc.)
    const texto = (
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      msg.message.imageMessage?.caption ||
      msg.message.videoMessage?.caption ||
      ''
    ).toLowerCase().trim();

    // Si mandó solo un sticker, imagen o audio sin texto
    if (!texto) {
      console.log(`[Mensaje Recibido] Mensaje sin texto (sticker/audio/media) de ${remitente}. Ignorando.`);
      return;
    }

    // Limpiar caracteres invisibles, espacios y emojis para comparar números
    const soloNumeros = texto.replace(/[^0-9]/g, '');

    try {
      const res = await fetch(`${API_BASE_URL}/barberia/${BARBERIA_SLUG}`);
      if (!res.ok) return;
      const data = await res.json();
      const barberia = data.barberia || data;

      if (barberia.botActivo === false) return;

      // 1. Preguntas Frecuentes personalizadas desde el panel
      const reglas = barberia.botReglas || [];
      for (const regla of reglas) {
        const palabras = regla.palabrasClave.split(',').map(p => p.trim().toLowerCase());
        if (palabras.some(p => p && texto.includes(p))) {
          await sock.sendMessage(remitente, { text: regla.respuesta });
          return;
        }
      }

      // 2. Precios y Servicios (opción 2 o palabras clave)
      if (
        soloNumeros === '2' ||
        texto === '2' ||
        texto.includes('precio') || 
        texto.includes('cuanto vale') || 
        texto.includes('cuánto vale') || 
        texto.includes('cuanto cuesta') || 
        texto.includes('cuánto cuesta') || 
        texto.includes('valor') || 
        texto.includes('costo') || 
        texto.includes('servicio') || 
        texto.includes('corte') || 
        texto.includes('barba')
      ) {
        const nombreBarberia = barberia.nombre || 'BarberFlow';
        let lista = `💈 *Servicios y Precios — ${nombreBarberia}*\n`;
        lista += `─────────────────────────\n\n`;

        if (barberia.servicios && barberia.servicios.length > 0) {
          barberia.servicios.forEach(s => {
            lista += `✂️ *${s.nombre}*\n`;
            lista += `   └ 💵 *$${Number(s.precio).toLocaleString('es-CO')}* · ⏱️ ${s.duracionMinutos || 30} min\n\n`;
          });
        } else {
          lista += `✂️ *Corte Clásico / Fade:* $ 30.000\n✂️ *Corte + Barba:* $ 30.000\n✂️ *Diseño de Barba:* $ 12.000\n\n`;
        }

        lista += `─────────────────────────\n`;
        lista += `⚡ *¿Deseas asegurar tu turno ahora?*\n`;
        lista += `Agenda en 30 segundos sin esperas aquí:\n`;
        lista += `👉 https://barberflow-aos9.onrender.com/index.html?b=${BARBERIA_SLUG}\n\n`;
        lista += `_O si deseas atención personalizada, déjanos tu duda y el barbero te responderá._ ✨`;

        await sock.sendMessage(remitente, { text: lista });
        return;
      }

      // 3. Saludos / Menú principal (opción 1 o saludos)
      if (
        soloNumeros === '1' ||
        texto === '1' ||
        texto.includes('hola') || 
        texto.includes('buenas') || 
        texto.includes('buenos dias') || 
        texto.includes('buenos días') || 
        texto.includes('buenas tardes') || 
        texto.includes('buenas noches') || 
        texto.includes('info') || 
        texto.includes('menu') || 
        texto.includes('menú')
      ) {
        const msj = `💈 *Bienvenido a ${barberia.nombre || 'BarberFlow'}*\n\n` +
          `¿En qué te podemos colaborar hoy?\n\n` +
          `1️⃣ 📅 *Agendar tu cita en línea:*\n` +
          `👉 https://barberflow-aos9.onrender.com/index.html?b=${BARBERIA_SLUG}\n\n` +
          `2️⃣ ✂️ *Ver precios y catálogo de servicios:*\n` +
          `   _(Responde "2" o escribe "precios")_\n\n` +
          `3️⃣ 📍 *Ubicación y Horarios:*\n` +
          `   _(Responde "3" o escribe "ubicación")_\n\n` +
          `_Escribe el número de tu opción (1, 2 o 3) o déjanos tu duda y el barbero te responderá._ ✨`;

        await sock.sendMessage(remitente, { text: msj });
        return;
      }

      // 4. Ubicación / Dónde quedan (opción 3 o palabras clave)
      if (
        soloNumeros === '3' ||
        texto === '3' ||
        texto.includes('donde') || 
        texto.includes('dónde') || 
        texto.includes('direccion') || 
        texto.includes('dirección') || 
        texto.includes('ubicacion') || 
        texto.includes('ubicación')
      ) {
        const ubi = `📍 *Ubicación y Horario de Atención:*\n\n` +
          `🏠 *Dirección:* ${barberia.direccion || 'Calle 45 # 12-34'}\n` +
          `⏰ *Horario:* ${barberia.horarioTexto || 'Lunes a Sábado 9:00 AM - 8:00 PM'}\n\n` +
          `📅 *Reserva tu cita aquí para no hacer fila:* \n👉 https://barberflow-aos9.onrender.com/index.html?b=${BARBERIA_SLUG}`;
        await sock.sendMessage(remitente, { text: ubi });
        return;
      }

      // 🛡️ REGLA 4: Derivación humana máx 1 vez cada 2 horas por persona
      const ultimaVezDerivado = ultimaRespuestaHumana.get(remitente) || 0;
      const dosHorasMs = 2 * 60 * 60 * 1000;

      if (ahora - ultimaVezDerivado > dosHorasMs) {
        const derivacion = barberia.mensajeDerivacionHumana || 
          'He recibido tu mensaje. En este momento el barbero está en servicio con un cliente ✂️💈. Tan pronto termine su turno, te responderá personalmente por este chat. ¡Muchas gracias por tu paciencia!';
        
        await sock.sendMessage(remitente, { text: derivacion });
        await sock.sendPresenceUpdate('paused', remitente);
        ultimaRespuestaHumana.set(remitente, ahora);
      } else {
        await sock.sendPresenceUpdate('paused', remitente);
      }

    } catch (e) {
      console.error('Error procesando mensaje en bot:', e);
    }
  });
}

iniciarBot();
