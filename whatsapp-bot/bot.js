import makeWASocket, { DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import http from 'http';
import fetch from 'node-fetch';
import fs from 'fs';

const PORT = process.env.PORT || 3001;
const API_BASE_URL = process.env.BARBERFLOW_API_URL || 'https://barberflow-aos9.onrender.com/api/public';
const BARBERIA_SLUG = process.env.BARBERIA_SLUG || 'barberia-jr';
const BASE_WEB_URL = process.env.BARBERFLOW_WEB_URL || 'https://barberflow-aos9.onrender.com';

const ultimaInteraccionCliente = new Map(); // Para saber cuándo habló por última vez
const ultimaDerivacionMap = new Map(); // Para registrar el tiempo exacto de derivación por remitente
const estadoCliente = new Map(); // Menús o confirmaciones de cancelación
let cacheBarberia = null;
let ultimaCargaCache = 0;

let ultimoQrDataUrl = '';
let estadoConexion = 'Generando QR...';
let estaConectado = false;
let socketActivo = null;

// Control de envío único del Anuncio Matutino diario
let ultimoDiaAnuncioEnviado = '';

// Utilidad para extraer solo el primer nombre
function obtenerPrimerNombre(nombreCompleto) {
  if (!nombreCompleto) return 'Cliente';
  const partes = nombreCompleto.trim().split(/\s+/);
  const primer = partes[0] || 'Cliente';
  return primer.charAt(0).toUpperCase() + primer.slice(1).toLowerCase();
}

// Formatear teléfono a JID de Baileys (ej: 573001234567@s.whatsapp.net)
function formatearJidWhatsApp(telefono) {
  if (!telefono) return null;
  let limpio = telefono.replace(/[^0-9]/g, '');
  if (limpio.length === 10 && limpio.startsWith('3')) {
    limpio = `57${limpio}`; // Código país Colombia por defecto
  }
  return `${limpio}@s.whatsapp.net`;
}

// Función auxiliar para responder de forma natural (escribiendo... ~1.8s)
const enviarMensajeHumano = async (sock, remitente, textoRespuesta) => {
  try {
    if (!sock || !estaConectado) return false;
    await sock.sendPresenceUpdate('composing', remitente);
    await new Promise(r => setTimeout(r, 1800));
    await sock.sendMessage(remitente, { text: textoRespuesta });
    await sock.sendPresenceUpdate('paused', remitente);
    return true;
  } catch (err) {
    console.error('Error enviando mensaje WhatsApp:', err);
    return false;
  }
};

// Cargar o refrescar datos de la barbería en segundo plano cada 60s
async function obtenerDatosBarberia() {
  const ahoraTs = Date.now();
  if (!cacheBarberia || ahoraTs - ultimaCargaCache > 60000) {
    try {
      const res = await fetch(`${API_BASE_URL}/barberia/${BARBERIA_SLUG}`, { timeout: 4000 });
      if (res.ok) {
        const data = await res.json();
        cacheBarberia = data.barberia || data;
        ultimaCargaCache = ahoraTs;
      }
    } catch (fetchErr) {
      console.log('Nota: usando cache local para barbería:', fetchErr.message);
    }
  }

  return cacheBarberia || {
    nombre: 'Barberia JR',
    botActivo: true,
    direccion: 'Calle 45 # 12-34',
    telefonoWhatsApp: '573001234567',
    horarioTexto: 'Lunes a Sábado 9:00 AM - 8:00 PM',
    anuncioMatutinoActivo: true,
    horaAnuncioSemana: '08:00',
    horaAnuncioSabado: '08:00',
    horaAnuncioDomingo: '09:00',
    servicios: [
      { categoria: 'Cortes', nombre: 'Corte Moderno', precio: 30000, duracionMinutos: 30 },
      { categoria: 'Cortes', nombre: 'Corte más Barba', precio: 30000, duracionMinutos: 60 },
      { categoria: 'Cortes', nombre: 'Diseño de Barba', precio: 12000, duracionMinutos: 20 },
      { categoria: 'Limpieza facial', nombre: 'Limpieza facial profunda', precio: 17000, duracionMinutos: 40 },
      { categoria: 'Uñas', nombre: 'Arreglo de uñas', precio: 35000, duracionMinutos: 60 }
    ]
  };
}

// ----------------- SERVIDOR HTTP Y WEBHOOKS -----------------
http.createServer(async (req, res) => {
  // Encabezados CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // 1. Endpoint para resetear sesión de WhatsApp
  if (req.url.startsWith('/api/reset')) {
    try {
      fs.rmSync('./auth_info_baileys', { recursive: true, force: true });
    } catch (e) {}
    ultimoQrDataUrl = '';
    estaConectado = false;
    estadoConexion = 'Generando nuevo QR...';
    iniciarBot();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, mensaje: 'Sesión reseteada. QR en camino.' }));
    return;
  }

  // 2. Endpoint de Estado del Bot para el panel de administración
  if (req.url.startsWith('/api/status')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      conectado: estaConectado,
      estado: estadoConexion,
      qr: ultimoQrDataUrl
    }));
    return;
  }

  // 3. Webhook: Notificación Automática de Cita Agendada (Web ➔ WhatsApp)
  if (req.method === 'POST' && req.url.startsWith('/api/notificar-cita')) {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const {
          citaId,
          codigoReserva,
          barberiaNombre,
          barberiaDireccion,
          nombreCliente,
          telefonoCliente,
          servicio,
          fecha,
          hora,
          total
        } = payload;

        if (!telefonoCliente || !socketActivo || !estaConectado) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ enviado: false, razon: 'Bot no conectado o sin teléfono' }));
          return;
        }

        const jid = formatearJidWhatsApp(telefonoCliente);
        const primerNombre = obtenerPrimerNombre(nombreCliente);
        const ultimaVez = ultimaInteraccionCliente.get(jid) || 0;
        const ahora = Date.now();
        const yaHabloReciente = (ahora - ultimaVez) < (30 * 60 * 1000); // 30 minutos

        let saludoInicial = yaHabloReciente
          ? `¡Listo ${primerNombre}! ✅ Tu turno ha quedado agendado en el sistema 💈`
          : `¡Hola ${primerNombre}! 👋 Gracias por reservar en *${barberiaNombre || 'Barbería JR'}* 💈✂️`;

        const msgConfirmacion = 
          `${saludoInicial}\n\n` +
          `📋 *Detalles de tu Cita:*\n` +
          `✂️ *Servicio:* ${servicio}\n` +
          `📅 *Fecha:* ${fecha}\n` +
          `⏰ *Hora:* ${hora}\n` +
          `🔖 *Código:* ${codigoReserva || '#BF-CITA'}\n` +
          `💵 *Valor:* $${Number(total || 0).toLocaleString('es-CO')}\n` +
          `📍 *Dirección:* ${barberiaDireccion || 'En la barbería'}\n\n` +
          `━━━━━━━━━━━━━━━━━━━━\n` +
          `💡 *Gestión rápida de tu cita:*\n` +
          `• Responde *SI* para reconfirmar que asistirás ✅\n` +
          `• Responde *CANCELAR* si te surge un imprevisto ❌\n` +
          `• Responde *REAGENDAR* si deseas cambiar de horario 🔄\n` +
          `━━━━━━━━━━━━━━━━━━━━\n` +
          `¡Te esperamos con la mejor atención! 💈✨`;

        await enviarMensajeHumano(socketActivo, jid, msgConfirmacion);
        ultimaInteraccionCliente.set(jid, ahora);

        // Agendar recordatorio de reseña post-cita (ejemplo: 2 horas después de la cita)
        agendarEncuestaPostCita(jid, primerNombre, citaId, barberiaNombre, fecha, hora);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ enviado: true, jid }));
      } catch (err) {
        console.error('Error enviando notificación automática de cita:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
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
  console.log(`Servidor del Bot y Webhooks activo en el puerto ${PORT}`);
});

// Función para enviar solicitud de reseña post-cita (calificación 1 a 5 estrellas verificada)
function agendarEncuestaPostCita(jid, primerNombre, citaId, barberiaNombre, fecha, hora) {
  // Simulador programado: 2 horas de retraso (o 10 minutos para demostración si es el mismo día)
  // Calculamos la hora de envío prudente
  setTimeout(async () => {
    try {
      if (!socketActivo || !estaConectado) return;
      const urlCalificar = `${BASE_WEB_URL}/index.html?calificar=${citaId}`;
      const msgResena = 
        `¡Hola ${primerNombre}! 👋 Esperamos que hayas quedado 10/10 con tu corte de hoy en *${barberiaNombre || 'Barbería JR'}* 💈✂️\n\n` +
        `Tu opinión es muy importante para nosotros. ¿Podrías dejarnos tu calificación y comentario aquí en menos de 10 segundos? ⭐\n\n` +
        `👉 ${urlCalificar}\n\n` +
        `¡Muchas gracias por preferirnos! 🔥`;

      await enviarMensajeHumano(socketActivo, jid, msgResena);
    } catch (e) {
      console.log('Error enviando encuesta post-cita:', e.message);
    }
  }, 2 * 60 * 60 * 1000); // 2 horas
}

// ----------------- MOTOR DEL BOT BAILEYS -----------------
async function iniciarBot() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info_baileys');
  const sock = makeWASocket({ auth: state, printQRInTerminal: false });
  socketActivo = sock;

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
      const statusCode = (lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(`[Conexión cerrada] StatusCode: ${statusCode} | shouldReconnect: ${shouldReconnect}`);
      
      if (shouldReconnect) {
        estadoConexion = 'Reconectando automáticamente...';
        setTimeout(iniciarBot, 3000);
      } else {
        estadoConexion = 'Sesión expirada. Generando nuevo código QR...';
        try {
          fs.rmSync('./auth_info_baileys', { recursive: true, force: true });
        } catch (e) {}
        setTimeout(iniciarBot, 2000);
      }
    } else if (connection === 'open') {
      estaConectado = true;
      ultimoQrDataUrl = '';
      estadoConexion = 'Conectado';
      console.log('¡WhatsApp en línea y conectado!');
    }
  });

  sock.ev.on('messages.upsert', async (m) => {
    try {
      if (!m.messages || m.messages.length === 0) return;
      const msg = m.messages[0];
      if (!msg.message) return;

      const remitente = msg.key.remoteJid;
      // 🛡️ REGLA 1: Ignorar grupos y difusiones
      if (!remitente || remitente.includes('@g.us') || remitente.includes('broadcast')) return;

      // ⚠️ Ignorar mensajes propios
      if (msg.key.fromMe) return;

      const texto = (
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        msg.message.videoMessage?.caption ||
        ''
      ).toLowerCase().trim();

      if (!texto) return;

      const ahora = Date.now();
      ultimaInteraccionCliente.set(remitente, ahora);
      const soloNumeros = texto.replace(/[^0-9]/g, '');

      const barberia = await obtenerDatosBarberia();
      if (barberia.botActivo === false) return;

      // Extraer número de teléfono del remitente (ej: 573001234567@s.whatsapp.net -> 3001234567 o últimos 10 dígitos)
      const telSoloDigitos = remitente.replace(/[^0-9]/g, '');
      const telBusqueda = telSoloDigitos.length >= 10 ? telSoloDigitos.slice(-10) : telSoloDigitos;

      const estado = estadoCliente.get(remitente) || { nivel: 'INICIO' };

      // ----------------- FLUJO DE CANCELACIÓN CON CONFIRMACIÓN SEGURA -----------------
      if (estado.nivel === 'CONFIRMAR_CANCELACION') {
        if (soloNumeros === '1' || texto.includes('si') || texto.includes('sí') || texto.includes('cancelar')) {
          // Confirmó cancelar la cita
          try {
            const resCanc = await fetch(`${API_BASE_URL}/bot/cancelar-cita/${estado.citaId}`, { method: 'POST' });
            if (resCanc.ok) {
              estadoCliente.set(remitente, { nivel: 'INICIO' });
              const nombreCliente = estado.citaNombre || 'amigo';
              const msjCancelado = 
                `✅ ¡Listo ${nombreCliente}! Tu cita para el *${estado.citaFecha} a las ${estado.citaHora}* ha sido cancelada correctamente.\n\n` +
                `Lamentamos que no nos puedas acompañar en esta ocasión, ¡esperamos verte muy pronto en la barbería! 💈✂️\n\n` +
                `Cuando desees volver a agendar tu espacio, estaremos encantados de atenderte aquí:\n` +
                `👉 ${BASE_WEB_URL}/index.html?b=${BARBERIA_SLUG}`;

              await enviarMensajeHumano(sock, remitente, msjCancelado);

              // 🔔 NOTIFICAR INMEDIATAMENTE AL BARBERO QUE SE CANCELÓ UN TURNO
              try {
                const jidBarbero = formatearJidWhatsApp(barberia.telefonoWhatsApp);
                if (jidBarbero && jidBarbero !== remitente) {
                  const msjAvisoBarbero = 
                    `🔔 *Notificación de Agenda:*\n` +
                    `El cliente *${nombreCliente}* canceló su turno del *${estado.citaFecha}* a las *${estado.citaHora}*.\n\n` +
                    `✅ Ese horario quedó libre automáticamente en tu calendario web.`;
                  await sock.sendMessage(jidBarbero, { text: msjAvisoBarbero });
                }
              } catch (errBarbero) {
                console.error('Error notificando al barbero sobre cancelación:', errBarbero);
              }

              return;
            }
          } catch (e) {
            console.error('Error cancelando cita en API:', e);
          }
        } else if (soloNumeros === '2' || texto.includes('no') || texto.includes('mantener')) {
          // Desea mantener la cita
          estadoCliente.set(remitente, { nivel: 'INICIO' });
          await enviarMensajeHumano(
            sock,
            remitente,
            `👍 ¡Perfecto! Tu cita para el *${estado.citaFecha} a las ${estado.citaHora}* sigue firme y reservada. ¡Te esperamos! 💈✂️`
          );
          return;
        }
      }

      // 1. SOLICITUD DE CANCELACIÓN ("cancelar", "cancelar cita", etc.)
      if (texto.includes('cancelar') || texto.includes('cancelo') || texto === 'cancelar cita') {
        try {
          const res = await fetch(`${API_BASE_URL}/bot/citas-cliente/${telBusqueda}`);
          if (res.ok) {
            const cita = await res.json();
            const primerNombre = obtenerPrimerNombre(cita.nombreCliente);

            estadoCliente.set(remitente, {
              nivel: 'CONFIRMAR_CANCELACION',
              citaId: cita.id,
              citaFecha: cita.fecha,
              citaHora: cita.hora,
              citaNombre: primerNombre
            });

            const msjConfirmacion = 
              `Hola ${primerNombre}, encontramos tu cita agendada:\n\n` +
              `✂️ *Servicio:* ${cita.servicio}\n` +
              `📅 *Fecha:* ${cita.fecha}\n` +
              `⏰ *Hora:* ${cita.hora}\n` +
              `🔖 *Código:* ${cita.codigoReserva}\n\n` +
              `¿Deseas confirmar la cancelación de este turno?\n\n` +
              `*1*️⃣ Sí, cancelar mi cita ❌\n` +
              `*2*️⃣ No, mantener mi turno ✅\n\n` +
              `_Responde con el número *1* o *2*._`;

            await enviarMensajeHumano(sock, remitente, msjConfirmacion);
            return;
          } else {
            await enviarMensajeHumano(
              sock,
              remitente,
              `No encontramos citas activas asociadas a este número de WhatsApp. Si necesitas agendar una nueva, puedes hacerlo aquí:\n👉 ${BASE_WEB_URL}/index.html?b=${BARBERIA_SLUG}`
            );
            return;
          }
        } catch (e) {
          console.error('Error buscando cita cliente:', e);
        }
      }

      // 2. SOLICITUD DE REAGENDAR ("reagendar", "cambiar cita", "mover turno")
      if (texto.includes('reagendar') || texto.includes('cambiar fecha') || texto.includes('cambiar hora') || texto.includes('mover cita')) {
        try {
          const res = await fetch(`${API_BASE_URL}/bot/citas-cliente/${telBusqueda}`);
          let urlReagendar = `${BASE_WEB_URL}/index.html?b=${BARBERIA_SLUG}`;
          let detalle = '';

          if (res.ok) {
            const cita = await res.json();
            urlReagendar = `${BASE_WEB_URL}/index.html?b=${BARBERIA_SLUG}&reagendar=${cita.id}`;
            detalle = ` de tu cita activa (*${cita.servicio}* para el *${cita.fecha} a las ${cita.hora}*)`;
          }

          const msjReagendar = 
            `🔄 *Reagendar Turno — ${barberia.nombre || 'Barbería JR'}*\n\n` +
            `Para cambiar el día y hora${detalle}, ingresa a nuestro calendario visual aquí:\n\n` +
            `👉 ${urlReagendar}\n\n` +
            `_Al seleccionar tu nuevo horario, tu turno anterior se actualizará automáticamente._ ✨`;

          await enviarMensajeHumano(sock, remitente, msjReagendar);
          return;
        } catch (e) {}
      }

      // 3. RESPUESTAS A CONFIRMACIÓN ("si", "confirmo", "asistiré", "confirmado")
      if (texto === 'si' || texto === 'sí' || texto === 'confirmo' || texto === 'confirmar' || texto === 'confirmado' || texto === 'asistire' || texto === 'asistiré') {
        await enviarMensajeHumano(
          sock,
          remitente,
          `¡Excelente! ✅ Tu turno ha sido reconfirmado. Tu barbero tendrá tu estación lista y limpia a tu llegada. ¡Nos vemos pronto! 💈✂️`
        );
        return;
      }

      // Agrupar categorías de servicios
      const serviciosLista = barberia.servicios || [];
      const categoriasMap = new Map();
      serviciosLista.forEach(s => {
        const cat = s.categoria || 'Servicios Generales';
        if (!categoriasMap.has(cat)) categoriasMap.set(cat, []);
        categoriasMap.get(cat).push(s);
      });
      const categoriasNombres = Array.from(categoriasMap.keys());

      // 4. Preguntas Frecuentes personalizadas desde el panel
      const reglas = barberia.botReglas || [];
      for (const regla of reglas) {
        const palabras = regla.palabrasClave.split(',').map(p => p.trim().toLowerCase());
        if (palabras.some(p => p && texto.includes(p))) {
          await enviarMensajeHumano(sock, remitente, regla.respuesta);
          return;
        }
      }

      // Regresar al menú principal con 0 o inicio
      if (soloNumeros === '0' || texto === 'menu' || texto === 'menú' || texto === 'volver' || texto === 'inicio') {
        estadoCliente.set(remitente, { nivel: 'INICIO' });
        const msj = `💈 *Bienvenido a ${barberia.nombre || 'Barberia JR'}*\n\n` +
          `¿En qué te podemos colaborar hoy?\n\n` +
          `1️⃣ 📅 *Agendar tu cita en línea:*\n` +
          `👉 ${BASE_WEB_URL}/index.html?b=${BARBERIA_SLUG}\n\n` +
          `2️⃣ ✂️ *Ver servicios y precios por categorías*\n\n` +
          `3️⃣ 📍 *Ubicación y Horarios*\n\n` +
          `4️⃣ 💳 *Métodos de Pago (Nequi / Bancolombia)*\n\n` +
          `_Responde con el número de tu opción (1, 2, 3 o 4) o escribe tu duda._ ✨`;
        await enviarMensajeHumano(sock, remitente, msj);
        return;
      }

      // SUBMENÚ DE CATEGORÍAS DE SERVICIOS
      if (estado.nivel === 'SERVICIOS') {
        const opcionCatIndex = parseInt(soloNumeros, 10) - 1;
        if (!isNaN(opcionCatIndex) && opcionCatIndex >= 0 && opcionCatIndex < categoriasNombres.length) {
          const catSeleccionada = categoriasNombres[opcionCatIndex];
          const serviciosCat = categoriasMap.get(catSeleccionada) || [];

          let lista = `💈 *${catSeleccionada} — ${barberia.nombre || 'Barberia JR'}*\n`;
          lista += `─────────────────────────\n\n`;

          serviciosCat.forEach(s => {
            lista += `✂️ *${s.nombre}*\n`;
            lista += `   💵 $ ${Number(s.precio).toLocaleString('es-CO')}  ·  ⏱️ ${s.duracionMinutos || 30} min\n\n`;
          });

          lista += `─────────────────────────\n`;
          lista += `📅 *Reserva tu turno aquí:* \n👉 ${BASE_WEB_URL}/index.html?b=${BARBERIA_SLUG}\n\n`;
          lista += `_Responde *0* para volver al menú principal._`;

          await enviarMensajeHumano(sock, remitente, lista);
          return;
        }
      }

      // 5. Precios y Servicios (Abrir submenú de categorías)
      if (
        soloNumeros === '2' ||
        texto === '2' ||
        texto.includes('precio') || 
        texto.includes('servicios') || 
        texto.includes('servicio') || 
        texto.includes('cuanto vale') || 
        texto.includes('cuánto vale') || 
        texto.includes('costo') || 
        texto.includes('cortes') || 
        texto.includes('corte')
      ) {
        estadoCliente.set(remitente, { nivel: 'SERVICIOS' });

        let menuServicios = `💈 *Catálogo de Servicios — ${barberia.nombre || 'Barberia JR'}*\n`;
        menuServicios += `Elige la categoría que deseas consultar:\n\n`;

        categoriasNombres.forEach((cat, index) => {
          let icono = '✂️';
          if (cat.toLowerCase().includes('facial') || cat.toLowerCase().includes('limpieza')) icono = '✨';
          else if (cat.toLowerCase().includes('uña') || cat.toLowerCase().includes('manos')) icono = '💅';
          else if (cat.toLowerCase().includes('barba')) icono = '🧔';
          else if (cat.toLowerCase().includes('tinte') || cat.toLowerCase().includes('color')) icono = '🎨';

          menuServicios += `*${index + 1}*️⃣ ${icono} *${cat}*\n`;
        });

        menuServicios += `\n*0*️⃣ 🔙 *Volver al menú principal*\n\n`;
        menuServicios += `_Responde con el número de la categoría para ver sus precios._`;

        await enviarMensajeHumano(sock, remitente, menuServicios);
        return;
      }

      // 6. Saludos / Menú principal
      if (
        soloNumeros === '1' ||
        texto === '1' ||
        texto.includes('hola') || 
        texto.includes('buenas') || 
        texto.includes('buenos dias') || 
        texto.includes('buenos días') || 
        texto.includes('buenas tardes') || 
        texto.includes('buenas noches') || 
        texto.includes('info')
      ) {
        estadoCliente.set(remitente, { nivel: 'INICIO' });

        // Intentar consultar si ya es un cliente conocido en el sistema
        let saludoPersonalizado = `💈 *Bienvenido a ${barberia.nombre || 'Barberia JR'}*`;
        try {
          const resCli = await fetch(`${API_BASE_URL}/bot/citas-cliente/${telBusqueda}`);
          if (resCli.ok) {
            const datosCita = await resCli.json();
            if (datosCita && datosCita.nombreCliente) {
              const primer = obtenerPrimerNombre(datosCita.nombreCliente);
              saludoPersonalizado = `💈 *¡Hola ${primer}! Qué gusto tenerte de vuelta en ${barberia.nombre || 'Barberia JR'}*`;
            }
          }
        } catch (e) {}

        const msj = `${saludoPersonalizado}\n\n` +
          `¿En qué te podemos colaborar hoy?\n\n` +
          `1️⃣ 📅 *Agendar tu cita en línea:*\n` +
          `👉 ${BASE_WEB_URL}/index.html?b=${BARBERIA_SLUG}\n\n` +
          `2️⃣ ✂️ *Ver servicios y precios por categorías*\n\n` +
          `3️⃣ 📍 *Ubicación y Horarios*\n\n` +
          `4️⃣ 💳 *Métodos de Pago (Nequi / Bancolombia)*\n\n` +
          `_Responde con el número de tu opción (1, 2, 3 o 4) o escribe tu duda._ ✨`;

        await enviarMensajeHumano(sock, remitente, msj);
        return;
      }

      // 7. Ubicación / Dónde quedan
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
          `📅 *Reserva tu cita aquí para no hacer fila:* \n👉 ${BASE_WEB_URL}/index.html?b=${BARBERIA_SLUG}`;
        await enviarMensajeHumano(sock, remitente, ubi);
        return;
      }

      // 8. Métodos de Pago
      if (
        soloNumeros === '4' ||
        texto === '4' ||
        texto.includes('pago') || 
        texto.includes('pagar') || 
        texto.includes('nequi') || 
        texto.includes('bancolombia') || 
        texto.includes('transferencia') || 
        texto.includes('efectivo')
      ) {
        let msgPago = `💳 *Métodos de Pago — ${barberia.nombre || 'Barberia JR'}*\n`;
        msgPago += `─────────────────────────\n\n`;
        msgPago += `💵 *Efectivo:* Recibimos en el local al finalizar tu servicio.\n\n`;
        
        if (barberia.numeroNequi) {
          msgPago += `📱 *Nequi:* ${barberia.numeroNequi}\n`;
        }

        if (barberia.numeroDaviplata) {
          msgPago += `🏦 *Bancolombia:* ${barberia.numeroDaviplata}\n`;
        }

        if (barberia.titularCuenta) {
          msgPago += `👤 *Titular:* ${barberia.titularCuenta}\n`;
        }

        if (barberia.datosPago) {
          msgPago += `\nℹ️ _${barberia.datosPago}_\n`;
        }

        msgPago += `\n─────────────────────────\n`;
        msgPago += `📅 *Reserva tu cita aquí:* \n👉 ${BASE_WEB_URL}/index.html?b=${BARBERIA_SLUG}`;

        await enviarMensajeHumano(sock, remitente, msgPago);
        return;
      }

      // 9. DERIVACIÓN HUMANA INTELIGENTE (Preguntas libres o dudas no mapeadas)
      // Solo responder 1 vez cada 2 horas por cliente para no repetir en frases cortas seguidas
      const ultimaVezDerivado = ultimaDerivacionMap.get(remitente) || 0;
      const dosHorasMs = 2 * 60 * 60 * 1000;

      if (ahora - ultimaVezDerivado > dosHorasMs) {
        ultimaDerivacionMap.set(remitente, ahora);
        const derivacion = barberia.mensajeDerivacionHumana || 
          'He tomado nota de tu consulta. En este momento el barbero está en servicio con un cliente ✂️💈. Tan pronto termine su turno te responderá personalmente por este chat.';
        
        await enviarMensajeHumano(sock, remitente, derivacion);
      }

    } catch (e) {
      console.error('Error procesando mensaje en bot:', e);
    }
  });
}

// ----------------- CRON: ANUNCIO MATUTINO DIARIO CONFIGURABLE -----------------
setInterval(async () => {
  try {
    if (!socketActivo || !estaConectado) return;

    // Obtener hora actual en zona horaria local de Colombia (UTC-5)
    const fechaActual = new Date();
    const formatterHora = new Intl.DateTimeFormat('es-CO', {
      timeZone: 'America/Bogota',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
    const formatterDiaSemana = new Intl.DateTimeFormat('es-CO', {
      timeZone: 'America/Bogota',
      weekday: 'short'
    });
    const formatterFechaIso = new Intl.DateTimeFormat('es-CO', {
      timeZone: 'America/Bogota',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });

    const horaMinutoActual = formatterHora.format(fechaActual); // ej: "08:00"
    const diaSemana = formatterDiaSemana.format(fechaActual).toLowerCase(); // lun, mar, mié, jue, vie, sáb, dom
    const fechaIso = formatterFechaIso.format(fechaActual).split('/').reverse().join('-'); // YYYY-MM-DD

    // Evitar disparar más de una vez por día
    if (ultimoDiaAnuncioEnviado === fechaIso) return;

    const barberia = await obtenerDatosBarberia();
    if (!barberia.anuncioMatutinoActivo) return;

    // Determinar la hora configurada por el barbero según el día
    let horaObjetivo = barberia.horaAnuncioSemana || '08:00';
    if (diaSemana.includes('sáb') || diaSemana.includes('sab')) {
      horaObjetivo = barberia.horaAnuncioSabado || '08:00';
    } else if (diaSemana.includes('dom')) {
      horaObjetivo = barberia.horaAnuncioDomingo || '09:00';
    }

    if (horaMinutoActual === horaObjetivo) {
      // Disparar anuncio matutino a la barbería
      const res = await fetch(`${API_BASE_URL}/bot/resumen-diario/${BARBERIA_SLUG}?fecha=${fechaIso}`);
      if (res.ok) {
        const data = await res.json();
        const telefonoBarbero = data.telefonoWhatsApp;
        const jidBarbero = formatearJidWhatsApp(telefonoBarbero);

        if (jidBarbero) {
          let briefing = `🌅 *¡Buenos días, equipo de ${data.nombre}!* ☕💈\n`;
          briefing += `Aquí tienes tu programación y agenda para hoy *(${data.fecha})*:\n\n`;

          if (!data.citas || data.citas.length === 0) {
            briefing += `📅 *Sin citas agendadas por ahora.* ¡Un excelente día para recibir clientes directos y promocionar tu link de reservas! ✂️\n`;
          } else {
            briefing += `📌 *Total de citas programadas:* ${data.totalCitas}\n`;
            briefing += `💰 *Proyección estimada del día:* $${Number(data.totalIngresosEstimados).toLocaleString('es-CO')}\n\n`;
            briefing += `⏰ *Horarios reservados:*\n`;

            data.citas.forEach((c, idx) => {
              briefing += `${idx + 1}. 🕒 *${c.hora}* · ${c.nombreCliente} (${c.servicio})\n`;
            });

            briefing += `\n_Para ver o editar tu agenda en vivo:_\n👉 ${BASE_WEB_URL}/admin.html`;
          }

          await enviarMensajeHumano(socketActivo, jidBarbero, briefing);
          ultimoDiaAnuncioEnviado = fechaIso;
          console.log(`[Anuncio Matutino Enviado] Fecha: ${fechaIso} | Hora: ${horaMinutoActual}`);
        }
      }
    }
  } catch (err) {
    console.error('Error en Cron de Anuncio Matutino:', err.message);
  }
}, 30000); // Revisar cada 30 segundos

iniciarBot();
