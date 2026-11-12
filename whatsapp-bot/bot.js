// BarberFlow WhatsApp Bot Gateway (Baileys)
// Conecta WhatsApp vía QR y responde automáticamente según las reglas y citas de BarberFlow

import makeWASocket, { DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import fetch from 'node-fetch';

const API_BASE_URL = process.env.BARBERFLOW_API_URL || 'https://barberflow-aos9.onrender.com/api/public';
const BARBERIA_SLUG = process.env.BARBERIA_SLUG || 'barberia-jr';

async function iniciarBot() {
  console.log('🤖 Iniciando BarberFlow WhatsApp Bot...');
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info_baileys');

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\n📱 ESCANEA ESTE CÓDIGO QR CON TU WHATSAPP (Dispositivos Vinculados):\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('⚠️ Conexión cerrada. ¿Reconectar?:', shouldReconnect);
      if (shouldReconnect) {
        iniciarBot();
      }
    } else if (connection === 'open') {
      console.log('✅ ¡Bot de WhatsApp conectado y listo para recibir mensajes!');
    }
  });

  // Escuchar mensajes entrantes
  sock.ev.on('messages.upsert', async (m) => {
    const msg = m.messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const remitente = msg.key.remoteJid;
    const texto = (
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      ''
    ).toLowerCase().trim();

    if (!texto) return;

    console.log(`📩 Mensaje recibido de ${remitente}: "${texto}"`);

    try {
      // 1. Obtener la información y reglas activas de la barbería
      const res = await fetch(`${API_BASE_URL}/barberia/${BARBERIA_SLUG}`);
      if (!res.ok) return;
      const data = await res.json();
      const barberia = data.barberia || data;

      if (barberia.botActivo === false) return;

      // 2. Revisar si coincide con alguna Regla Personalizada
      const reglas = barberia.botReglas || [];
      for (const regla of reglas) {
        const palabras = regla.palabrasClave.split(',').map(p => p.trim().toLowerCase());
        const coincide = palabras.some(p => p && texto.includes(p));
        if (coincide) {
          await sock.sendMessage(remitente, { text: regla.respuesta });
          return;
        }
      }

      // 3. Saludo o menú de opciones
      if (texto.includes('hola') || texto.includes('buenas') || texto.includes('info') || texto === 'menu') {
        const bienvenida = (barberia.mensajeBienvenidaBot || '¡Hola! 💈 Bienvenido a {barberia}. ¿En qué podemos ayudarte?')
          .replace('{barberia}', barberia.nombre || 'la barbería');

        const mensajeOpciones = `${bienvenida}\n\n` +
          `1️⃣ *Agendar una cita en línea:*\n👉 https://barberflow-aos9.onrender.com/index.html?b=${BARBERIA_SLUG}\n\n` +
          `2️⃣ *Dirección & Horario:*\n📍 ${barberia.direccion}\n⏰ ${barberia.horarioTexto}\n\n` +
          `Escribe tu duda o consulta y con gusto te ayudamos. ✂️`;

        await sock.sendMessage(remitente, { text: mensajeOpciones });
        return;
      }

      // 4. Consulta de precios / servicios
      if (texto.includes('precio') || texto.includes('costo') || texto.includes('cuanto vale') || texto.includes('servicio')) {
        let lista = `💈 *Precios y Servicios de ${barberia.nombre}:*\n\n`;
        (barberia.servicios || []).forEach(s => {
          lista += `✂️ *${s.nombre}* - $ ${Number(s.precio).toLocaleString()} (${s.duracionMinutos} min)\n`;
        });
        lista += `\n📅 *Reserva tu turno aquí:* https://barberflow-aos9.onrender.com/index.html?b=${BARBERIA_SLUG}`;
        await sock.sendMessage(remitente, { text: lista });
        return;
      }

      // 5. Si no coincide con nada conocido -> Derivación Humana Inteligente
      const derivacion = barberia.mensajeDerivacionHumana || 
        'He recibido tu mensaje. En este momento el barbero está en servicio con un cliente ✂️💈. Tan pronto termine su turno, te responderá personalmente por este chat. ¡Muchas gracias por tu paciencia!';
      await sock.sendMessage(remitente, { text: derivacion });

    } catch (err) {
      console.error('Error procesando mensaje en bot:', err);
    }
  });
}

iniciarBot();
