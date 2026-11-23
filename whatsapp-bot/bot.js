import makeWASocket, { DisconnectReason } from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import http from 'http';
import fetch from 'node-fetch';
import crypto from 'crypto';
import { crearAlmacenSesion } from './auth-postgres.js';

const PORT = process.env.PORT || 3001;
const API_BASE_URL = process.env.BARBERFLOW_API_URL || 'https://barberflow-aos9.onrender.com/api/public';
const BARBERIA_SLUG = process.env.BARBERIA_SLUG || 'barberia-jr';
const BASE_WEB_URL = process.env.BARBERFLOW_WEB_URL || 'https://barberflow-aos9.onrender.com';
// Clave compartida con la API (misma variable BOT_API_KEY en ambos servicios de Render)
const BOT_API_KEY = process.env.BOT_API_KEY || '';
if (!BOT_API_KEY) {
  console.warn('⚠️ BOT_API_KEY no está definida: la API rechazará las consultas del bot y los webhooks quedarán cerrados.');
}

// fetch hacia los endpoints /bot/* de la API, siempre con la clave del bot
function apiBotFetch(ruta, opciones = {}) {
  return fetch(`${API_BASE_URL}${ruta}`, {
    ...opciones,
    headers: { ...(opciones.headers || {}), 'X-Bot-Key': BOT_API_KEY }
  });
}

// Verifica el encabezado X-Bot-Key de las peticiones entrantes (API ➔ bot)
function peticionAutorizada(req) {
  if (!BOT_API_KEY) return false;
  const recibida = Buffer.from(String(req.headers['x-bot-key'] || ''));
  const esperada = Buffer.from(BOT_API_KEY);
  return recibida.length === esperada.length && crypto.timingSafeEqual(recibida, esperada);
}

function responderNoAutorizado(res) {
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'No autorizado' }));
}

// Modo prueba: no conecta WhatsApp ni abre el servidor; permite simular chats (ver pruebas/simular-chat.mjs)
const MODO_PRUEBA = process.env.BOT_MODO_PRUEBA === '1';

// WhatsApp puede identificar al remitente con un ID anónimo (…@lid) en lugar de su número.
// En ese caso el número real llega en msg.key.senderPn. Guardamos la relación LID ➔ teléfono.
const telefonoPorLid = new Map();

function digitosDeJid(jid) {
  return (jid || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
}

function telefonoDelRemitente(key) {
  const remoteJid = key?.remoteJid || '';
  if (remoteJid.endsWith('@s.whatsapp.net')) return digitosDeJid(remoteJid);

  const senderPn = key?.senderPn || '';
  if (senderPn.endsWith('@s.whatsapp.net')) {
    const tel = digitosDeJid(senderPn);
    if (remoteJid.endsWith('@lid') && tel) telefonoPorLid.set(remoteJid, tel);
    return tel;
  }

  return telefonoPorLid.get(remoteJid) || '';
}

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

// Formatear teléfono a JID de Baileys (ej: 573001234567@s.whatsapp.net o 17747126594@s.whatsapp.net)
function formatearJidWhatsApp(telefono) {
  if (!telefono) return null;
  let limpio = telefono.replace(/[^0-9]/g, '');
  // Si tiene 10 dígitos y empieza por 3 (Colombia local)
  if (limpio.length === 10 && limpio.startsWith('3')) {
    limpio = `57${limpio}`;
  }
  // Si tiene 10 dígitos en USA (ej: 7747126594), anteponer prefijo 1
  else if (limpio.length === 10 && !limpio.startsWith('1') && !limpio.startsWith('57')) {
    limpio = `1${limpio}`;
  }
  // Si tiene 11 dígitos y empieza por 1 (ej: 17747126594), se deja limpio tal cual
  return `${limpio}@s.whatsapp.net`;
}

// Resolver el JID real de WhatsApp verificando en los servidores de Baileys
async function resolverJidDestinatario(sock, telefono) {
  const jidDirecto = formatearJidWhatsApp(telefono);
  if (!sock || !jidDirecto) return jidDirecto;

  try {
    const limpio = telefono.replace(/[^0-9]/g, '');
    const res = await sock.onWhatsApp(limpio);
    if (res && res.length > 0 && res[0].exists && res[0].jid) {
      return res[0].jid;
    }
  } catch (e) {
    console.log('Nota: fallback a JID directo:', e.message);
  }
  return jidDirecto;
}

// Función auxiliar para responder de forma natural (escribiendo... entre 2.5s y 4s según longitud)
const enviarMensajeHumano = async (sock, remitente, textoRespuesta) => {
  try {
    if (!sock || (!estaConectado && !MODO_PRUEBA)) return false;
    
    // Simular tiempo de lectura/escritura más creíble y humano:
    // Mínimo 2.5 segundos, y un poquito más si el texto es largo, con variación aleatoria humana (jitter)
    const delayBase = 2500;
    const delayExtraPorLongitud = Math.min(Math.floor((textoRespuesta || '').length * 15), 2000);
    const delayAleatorio = Math.floor(Math.random() * 800); // 0 a 800ms de variación natural
    const tiempoTotal = MODO_PRUEBA ? 0 : delayBase + delayExtraPorLongitud + delayAleatorio; // aprox 3 a 4.5 segundos

    await sock.sendPresenceUpdate('composing', remitente);
    await new Promise(r => setTimeout(r, tiempoTotal));
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
    nombre: 'la barbería',
    botActivo: true,
    direccion: '',
    telefonoWhatsApp: '',
    horarioTexto: '',
    anuncioMatutinoActivo: false,
    servicios: [],
    botReglas: []
  };
}

// ----------------- SERVIDOR HTTP Y WEBHOOKS -----------------
const servidorHttp = http.createServer(async (req, res) => {
  // Encabezados CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Todos los endpoints /api/* exigen la clave compartida con la API
  if (req.url.startsWith('/api/') && !peticionAutorizada(req)) {
    responderNoAutorizado(res);
    return;
  }

  // 1. Endpoint para resetear sesión de WhatsApp
  if (req.method === 'POST' && req.url.startsWith('/api/reset')) {
    try {
      await resetearSesionWhatsApp();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, mensaje: 'Sesión reseteada. QR en camino.' }));
    } catch (err) {
      console.error('Error reseteando la sesión de WhatsApp:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'No se pudo borrar la sesión guardada' }));
    }
    return;
  }

  // 2. Endpoint de Estado del Bot para el panel de administración
  if (req.url.startsWith('/api/status')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      barberiaSlug: BARBERIA_SLUG,
      conectado: estaConectado,
      estado: estadoConexion,
      qr: ultimoQrDataUrl
    }));
    return;
  }

  // 3. Webhooks desde la API (Web ➔ WhatsApp)
  const webhooks = {
    '/api/notificar-cita': manejarNotificarCita,
    '/api/notificar-cancelacion': manejarNotificarCancelacion
  };
  const ruta = req.url.split('?')[0];
  if (req.method === 'POST' && webhooks[ruta]) {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const resultado = await webhooks[ruta](JSON.parse(body || '{}'));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(resultado));
      } catch (err) {
        console.error(`Error en webhook ${ruta}:`, err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Página pública mínima (health check). El QR solo se entrega por /api/status con la clave.
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(`BarberFlow bot activo. WhatsApp ${estaConectado ? 'conectado' : 'sin conectar'}.`);
});

if (!MODO_PRUEBA) {
  servidorHttp.listen(PORT, () => {
    console.log(`Servidor del Bot y Webhooks activo en el puerto ${PORT}`);
  });
}

// ----------------- SEGUIMIENTO DE CITAS (confirmación, reseña, recordatorio) -----------------

// Minutos desde medianoche de una hora tipo "10:20am", "3:00 PM" o "15:00"
function horaAMinutos(hora) {
  const t = String(hora || '').toLowerCase().trim();
  const m = t.match(/(\d{1,2}):(\d{2})\s*(am|pm)?/);
  if (!m) return null;
  let h = Number(m[1]);
  if (m[3] === 'pm' && h < 12) h += 12;
  if (m[3] === 'am' && h === 12) h = 0;
  return h * 60 + Number(m[2]);
}

// Momento real (timestamp) de una cita en hora de Colombia (UTC-5, sin horario de verano)
function instanteCita(fechaIso, hora) {
  const [a, mes, d] = String(fechaIso || '').split('-').map(Number);
  const min = horaAMinutos(hora);
  if (!a || min === null) return null;
  return Date.UTC(a, mes - 1, d, 0, 0) + (min + 5 * 60) * 60 * 1000;
}

function fechaLegible(fechaIso) {
  const [a, m, d] = String(fechaIso || '').split('-').map(Number);
  if (!a) return fechaIso || '';
  return new Date(Date.UTC(a, m - 1, d, 12)).toLocaleDateString('es-CO', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' });
}

// Consulta si la cita sigue vigente antes de escribirle al cliente
async function citaSigueActiva(citaId) {
  try {
    const res = await apiBotFetch(`/bot/${BARBERIA_SLUG}/cita/${citaId}`);
    if (!res.ok) return false;
    const cita = await res.json();
    return cita.estado !== 'Cancelada';
  } catch (e) {
    return false;
  }
}

export async function manejarNotificarCita(payload) {
  const {
    citaId, codigoReserva, barberiaSlug, barberiaNombre, barberiaDireccion,
    nombreCliente, telefonoCliente, servicio, fecha, hora, total, duracionMinutos, esReagendamiento
  } = payload;

  // El bot atiende una sola barbería: ignorar reservas de otras
  if (barberiaSlug && barberiaSlug.toLowerCase() !== BARBERIA_SLUG.toLowerCase()) {
    return { enviado: false, razon: 'Reserva de otra barbería' };
  }
  if (!telefonoCliente || !socketActivo || (!estaConectado && !MODO_PRUEBA)) {
    return { enviado: false, razon: 'Bot no conectado o sin teléfono' };
  }

  const jid = await resolverJidDestinatario(socketActivo, telefonoCliente);
  const primerNombre = obtenerPrimerNombre(nombreCliente);
  const ahora = Date.now();
  const yaHabloReciente = (ahora - (ultimaInteraccionCliente.get(jid) || 0)) < 30 * 60 * 1000;

  const saludoInicial = esReagendamiento
    ? `🔄 ¡Listo ${primerNombre}! Tu cita fue *reagendada* con éxito 💈`
    : yaHabloReciente
      ? `¡Listo ${primerNombre}! ✅ Tu turno ha quedado agendado en el sistema 💈`
      : `¡Hola ${primerNombre}! 👋 Gracias por reservar en *${barberiaNombre || 'la barbería'}* 💈✂️`;

  const msgConfirmacion =
    `${saludoInicial}\n\n` +
    `📋 *Detalles de tu Cita:*\n` +
    `✂️ *Servicio:* ${servicio}\n` +
    `📅 *Fecha:* ${fechaLegible(fecha)}\n` +
    `⏰ *Hora:* ${hora}\n` +
    `🔖 *Código:* ${codigoReserva || '#BF-CITA'}\n` +
    `💵 *Valor:* $${Number(total || 0).toLocaleString('es-CO')}\n` +
    (barberiaDireccion ? `📍 *Dirección:* ${barberiaDireccion}\n` : '') +
    `\n━━━━━━━━━━━━━━━━━━━━\n` +
    `💡 *Gestión rápida de tu cita:*\n` +
    `• Responde *SI* para reconfirmar que asistirás ✅\n` +
    `• Responde *CANCELAR* si te surge un imprevisto ❌\n` +
    `• Responde *REAGENDAR* si deseas cambiar de horario 🔄\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `¡Te esperamos con la mejor atención! 💈✨`;

  await enviarMensajeHumano(socketActivo, jid, msgConfirmacion);
  ultimaInteraccionCliente.set(jid, ahora);

  const encuesta = agendarEncuestaPostCita(jid, primerNombre, citaId, barberiaNombre, fecha, hora, duracionMinutos);
  return { enviado: true, jid, encuestaEnMinutos: encuesta };
}

export async function manejarNotificarCancelacion(payload) {
  const { barberiaSlug, nombreCliente, servicio, fecha, hora } = payload;
  if (barberiaSlug && barberiaSlug.toLowerCase() !== BARBERIA_SLUG.toLowerCase()) {
    return { enviado: false, razon: 'Cancelación de otra barbería' };
  }
  if (!socketActivo || (!estaConectado && !MODO_PRUEBA)) return { enviado: false, razon: 'Bot no conectado' };

  const barberia = await obtenerDatosBarberia();
  const jidBarbero = formatearJidWhatsApp(barberia.telefonoWhatsApp);
  if (!jidBarbero) return { enviado: false, razon: 'La barbería no tiene WhatsApp configurado' };

  await socketActivo.sendMessage(jidBarbero, {
    text:
      `🔔 *Notificación de Agenda:*\n` +
      `El cliente *${nombreCliente}* canceló desde la web su turno de *${servicio}* del *${fechaLegible(fecha)}* a las *${hora}*.\n\n` +
      `✅ Ese horario quedó libre automáticamente en tu calendario.`
  });
  return { enviado: true, jid: jidBarbero };
}

// Solicitud de reseña: 1 hora después de que TERMINE la cita (no después de reservar).
// Devuelve en cuántos minutos se enviará, o null si no se programó.
// Nota: se guarda en memoria; si el servicio se reinicia antes, esa reseña no se envía.
const MAX_ESPERA_MS = 20 * 24 * 60 * 60 * 1000; // setTimeout no admite esperas mayores a ~24 días
function agendarEncuestaPostCita(jid, primerNombre, citaId, barberiaNombre, fecha, hora, duracionMinutos) {
  const inicio = instanteCita(fecha, hora);
  if (!inicio || !citaId) return null;
  const envio = inicio + ((Number(duracionMinutos) || 40) + 60) * 60 * 1000;
  const espera = envio - Date.now();
  if (espera < 0 || espera > MAX_ESPERA_MS) return null;

  setTimeout(async () => {
    try {
      if (!socketActivo || !estaConectado) return;
      if (!await citaSigueActiva(citaId)) return; // cancelada o reagendada: no pedir reseña
      const urlCalificar = `${BASE_WEB_URL}/index.html?b=${BARBERIA_SLUG}&calificar=${citaId}`;
      const msgResena =
        `¡Hola ${primerNombre}! 👋 Esperamos que hayas quedado 10/10 con tu servicio de hoy en *${barberiaNombre || 'la barbería'}* 💈✂️\n\n` +
        `Tu opinión es muy importante para nosotros. ¿Podrías dejarnos tu calificación y comentario aquí en menos de 10 segundos? ⭐\n\n` +
        `👉 ${urlCalificar}\n\n` +
        `¡Muchas gracias por preferirnos! 🔥`;
      await enviarMensajeHumano(socketActivo, jid, msgResena);
    } catch (e) {
      console.log('Error enviando encuesta post-cita:', e.message);
    }
  }, espera);
  return Math.round(espera / 60000);
}

// Recordatorio automático ~2 horas antes de cada cita confirmada de hoy.
// Se desactiva con RECORDATORIOS_ACTIVOS=0. Se recuerda en memoria qué citas ya se avisaron.
const recordatoriosEnviados = new Set();
export async function revisarRecordatorios(ahoraMs = Date.now()) {
  if (process.env.RECORDATORIOS_ACTIVOS === '0') return [];
  if (!socketActivo || (!estaConectado && !MODO_PRUEBA)) return [];

  const fechaIso = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date(ahoraMs));
  const res = await apiBotFetch(`/bot/resumen-diario/${BARBERIA_SLUG}?fecha=${fechaIso}`);
  if (!res.ok) return [];
  const data = await res.json();
  const enviados = [];

  for (const c of data.citas || []) {
    if (c.estado !== 'Confirmada' || !c.telefonoCliente || recordatoriosEnviados.has(c.id)) continue;
    const inicio = instanteCita(fechaIso, c.hora);
    if (!inicio) continue;
    const minutosFaltan = (inicio - ahoraMs) / 60000;
    if (minutosFaltan < 90 || minutosFaltan > 150) continue;

    recordatoriosEnviados.add(c.id);
    const jid = await resolverJidDestinatario(socketActivo, c.telefonoCliente);
    await enviarMensajeHumano(
      socketActivo,
      jid,
      `⏰ ¡Hola ${obtenerPrimerNombre(c.nombreCliente)}! Te recordamos tu cita de hoy en *${data.nombre || 'la barbería'}*:\n\n` +
      `✂️ *Servicio:* ${c.servicio}\n` +
      `🕒 *Hora:* ${c.hora}\n\n` +
      `Por favor llega 5 minutos antes. Si no puedes asistir, responde *CANCELAR* o *REAGENDAR*. 💈`
    );
    enviados.push(c.id);
  }
  return enviados;
}

// Solo para el simulador de pruebas
export function __usarSocketDePrueba(sock) {
  if (MODO_PRUEBA) socketActivo = sock;
}

// ----------------- MOTOR DEL BOT BAILEYS -----------------
// La sesión de WhatsApp vive en PostgreSQL si hay DATABASE_URL (sobrevive redeploys en Render);
// sin DATABASE_URL (local) en la carpeta ./auth_info_baileys. Ver auth-postgres.js.
let almacenSesion = null;
function obtenerAlmacenSesion() {
  almacenSesion ||= crearAlmacenSesion({ databaseUrl: process.env.DATABASE_URL, sesion: BARBERIA_SLUG })
    .then(almacen => {
      console.log(`Sesión de WhatsApp guardada en: ${almacen.descripcion}`);
      return almacen;
    })
    .catch(err => { almacenSesion = null; throw err; });
  return almacenSesion;
}

// Cada socket recibe un número; un reset lo incrementa para que el socket viejo
// (y sus reconexiones pendientes) dejen de actuar.
let generacionBot = 0;
function reintentarBot(generacion, ms) {
  setTimeout(() => { if (generacion === generacionBot) iniciarBot(); }, ms);
}

async function resetearSesionWhatsApp() {
  generacionBot++;
  const anterior = socketActivo;
  socketActivo = null;
  try { anterior?.end(undefined); } catch (e) {}
  ultimoQrDataUrl = '';
  estaConectado = false;
  estadoConexion = 'Generando nuevo QR...';
  try {
    await (await obtenerAlmacenSesion()).borrarSesion();
  } finally {
    iniciarBot();
  }
}

async function iniciarBot() {
  const generacion = ++generacionBot;
  let estadoAuth;
  try {
    estadoAuth = await (await obtenerAlmacenSesion()).cargarEstado();
  } catch (err) {
    console.error('No se pudo cargar la sesión de WhatsApp:', err.message);
    estadoConexion = 'No se pudo leer la sesión guardada. Reintentando...';
    reintentarBot(generacion, 10000);
    return;
  }
  if (generacion !== generacionBot) return; // un reset arrancó otro socket mientras se cargaba

  const { state, saveCreds } = estadoAuth;
  const sock = makeWASocket({ auth: state, printQRInTerminal: false });
  socketActivo = sock;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    if (generacion !== generacionBot) return; // socket reemplazado por un reset
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
        reintentarBot(generacion, 3000);
      } else {
        estadoConexion = 'Sesión expirada. Generando nuevo código QR...';
        try {
          await (await obtenerAlmacenSesion()).borrarSesion();
        } catch (e) {
          console.error('No se pudo borrar la sesión expirada:', e.message);
        }
        reintentarBot(generacion, 2000);
      }
    } else if (connection === 'open') {
      estaConectado = true;
      ultimoQrDataUrl = '';
      estadoConexion = 'Conectado';
      console.log('¡WhatsApp en línea y conectado!');
    }
  });

  sock.ev.on('messages.upsert', (m) => procesarMensajeEntrante(sock, m));
}

// ----------------- LÓGICA DE CONVERSACIÓN -----------------
export async function procesarMensajeEntrante(sock, m) {
    try {
      // Solo mensajes nuevos: al reconectar llegan mensajes de historial (type 'append') que no se deben contestar
      if (m.type && m.type !== 'notify') return;
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

      // Extraer número de teléfono del remitente (ej: 17747126594@s.whatsapp.net o 573024084425@s.whatsapp.net)
      const telSoloDigitos = telefonoDelRemitente(msg.key);
      const ultimos10 = telSoloDigitos.length >= 10 ? telSoloDigitos.slice(-10) : telSoloDigitos;
      const telBusqueda = telSoloDigitos;

      console.log(`[Mensaje Recibido] De: ${remitente} | Tel: ${telSoloDigitos || '(desconocido)'} | Texto: ${texto}`);
      if (!telSoloDigitos) {
        console.warn(`[Aviso] No se pudo obtener el número real de ${remitente} (sin senderPn).`);
      }

      const estado = estadoCliente.get(remitente) || { nivel: 'INICIO' };

      // ----------------- FLUJO DE CANCELACIÓN CON CONFIRMACIÓN SEGURA -----------------
      if (estado.nivel === 'CONFIRMAR_CANCELACION') {
        const palabras = texto.split(/[^a-z0-9áéíóúñü]+/).filter(Boolean);
        const vencido = ahora - (estado.desde || 0) > 10 * 60 * 1000;
        const quiereMenu = soloNumeros === '0' || ['menu', 'menú', 'inicio', 'volver'].includes(texto);

        if (vencido || quiereMenu) {
          // La pregunta caducó (10 min) o pidió el menú: seguir con el flujo normal
          estadoCliente.set(remitente, { nivel: 'INICIO' });
        } else {
          const dijoNo = palabras.includes('2') || palabras.includes('no') || texto.includes('mantener');
          const dijoSi = !dijoNo && (palabras.includes('1') || palabras.includes('si') || palabras.includes('sí') || texto.includes('cancela'));

          if (dijoSi) {
            estadoCliente.set(remitente, { nivel: 'INICIO' });
            let cancelada = false;
            try {
              const resCanc = await apiBotFetch(`/bot/${BARBERIA_SLUG}/cancelar-cita/${estado.citaId}`, { method: 'POST' });
              cancelada = resCanc.ok;
              if (!resCanc.ok) console.error(`[Cancelar] La API respondió ${resCanc.status} para la cita ${estado.citaId}`);
            } catch (e) {
              console.error('Error cancelando cita en API:', e);
            }

            if (!cancelada) {
              await enviarMensajeHumano(
                sock,
                remitente,
                `😕 No pudimos cancelar tu cita en este momento. Intenta de nuevo en unos minutos escribiendo *CANCELAR*, o el barbero te ayudará personalmente por este chat.`
              );
              return;
            }

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

          if (dijoNo) {
            estadoCliente.set(remitente, { nivel: 'INICIO' });
            await enviarMensajeHumano(
              sock,
              remitente,
              `👍 ¡Perfecto! Tu cita para el *${estado.citaFecha} a las ${estado.citaHora}* sigue firme y reservada. ¡Te esperamos! 💈✂️`
            );
            return;
          }

          // Respuesta ambigua: volver a preguntar en lugar de seguir con otros flujos
          await enviarMensajeHumano(
            sock,
            remitente,
            `Para confirmar, responde *1* si deseas *cancelar* tu cita del *${estado.citaFecha} a las ${estado.citaHora}*, o *2* si prefieres *mantenerla*. ✂️`
          );
          return;
        }
      }

      // Función auxiliar para buscar cita por teléfono (prueba número completo y últimos 10 dígitos)
      const buscarCitaClienteAsync = async () => {
        if (!telSoloDigitos) return null;
        try {
          console.log(`[Buscando Cita] Probando con tel: ${telSoloDigitos} y ultimos10: ${ultimos10}`);
          let res = await apiBotFetch(`/bot/${BARBERIA_SLUG}/citas-cliente/${telSoloDigitos}`);
          if (res.ok) {
            const data = await res.json();
            console.log(`[Cita Encontrada] id: ${data.id}`);
            return data;
          }
          if (ultimos10 && ultimos10 !== telSoloDigitos) {
            res = await apiBotFetch(`/bot/${BARBERIA_SLUG}/citas-cliente/${ultimos10}`);
            if (res.ok) {
              const data = await res.json();
              console.log(`[Cita Encontrada con ultimos10] id: ${data.id}`);
              return data;
            }
          }
        } catch (e) {
          console.error('[Error en buscarCitaClienteAsync]:', e.message);
        }
        return null;
      };

      // 1. SOLICITUD DE CANCELACIÓN ("cancelar", "cancelar cita", etc.)
      if (texto.includes('cancelar') || texto.includes('cancelo') || texto === 'cancelar cita') {
        try {
          const cita = await buscarCitaClienteAsync();
          if (cita) {
            const primerNombre = obtenerPrimerNombre(cita.nombreCliente);

            estadoCliente.set(remitente, {
              nivel: 'CONFIRMAR_CANCELACION',
              desde: Date.now(),
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
          } else if (!telSoloDigitos) {
            await enviarMensajeHumano(
              sock,
              remitente,
              `😕 No pudimos identificar tu número de WhatsApp para buscar tu cita. El barbero te ayudará personalmente por este chat en cuanto pueda.`
            );
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
          const cita = await buscarCitaClienteAsync();
          let urlReagendar = `${BASE_WEB_URL}/index.html?b=${BARBERIA_SLUG}`;
          let detalle = '';

          if (cita) {
            urlReagendar = `${BASE_WEB_URL}/index.html?b=${BARBERIA_SLUG}&reagendar=${cita.id}`;
            detalle = ` de tu cita activa (*${cita.servicio}* para el *${cita.fecha} a las ${cita.hora}*)`;
          }

          const msjReagendar = 
            `🔄 *Reagendar Turno — ${barberia.nombre || 'la barbería'}*\n\n` +
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
        const msj = `💈 *Bienvenido a ${barberia.nombre || 'la barbería'}*\n\n` +
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

          let lista = `💈 *${catSeleccionada} — ${barberia.nombre || 'la barbería'}*\n`;
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

        let menuServicios = `💈 *Catálogo de Servicios — ${barberia.nombre || 'la barbería'}*\n`;
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
        let saludoPersonalizado = `💈 *Bienvenido a ${barberia.nombre || 'la barbería'}*`;
        if (telBusqueda) try {
          const resCli = await apiBotFetch(`/bot/${BARBERIA_SLUG}/citas-cliente/${telBusqueda}`);
          if (resCli.ok) {
            const datosCita = await resCli.json();
            if (datosCita && datosCita.nombreCliente) {
              const primer = obtenerPrimerNombre(datosCita.nombreCliente);
              saludoPersonalizado = `💈 *¡Hola ${primer}! Qué gusto tenerte de vuelta en ${barberia.nombre || 'la barbería'}*`;
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
          `🏠 *Dirección:* ${barberia.direccion || 'Pregúntanos por este chat 📲'}\n` +
          `⏰ *Horario:* ${barberia.horarioTexto || 'Lunes a Sábado 9:00 AM - 8:00 PM'}\n\n` +
          `📅 *Reserva tu cita aquí para no hacer fila:* \n👉 ${BASE_WEB_URL}/index.html?b=${BARBERIA_SLUG}\n\n` +
          `_Responde *0* para volver al menú principal._ 🔙`;
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
        let msgPago = `💳 *Métodos de Pago — ${barberia.nombre || 'la barbería'}*\n`;
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
        msgPago += `📅 *Reserva tu cita aquí:* \n👉 ${BASE_WEB_URL}/index.html?b=${BARBERIA_SLUG}\n\n`;
        msgPago += `_Responde *0* para volver al menú principal._ 🔙`;

        await enviarMensajeHumano(sock, remitente, msgPago);
        return;
      }

      // 9. FILTRO INTELIGENTE DE MENSAJES CASUALES / DESPEDIDAS / RISAS
      // Si el mensaje es una reacción informal, despedida o risa, el bot guarda silencio como un humano
      const frasesCasual = [
        'jaja', 'jeje', 'jojo', 'gracias', 'muchas gracias', 'vale', 'dale', 'ok', 'okay', 
        'listo', 'lista', 'esta bien', 'está bien', 'asi es', 'así es', 'de una', 'perfecto', 
        'bueno', 'bien', 'chimba', 'genial', 'excelente', 'uy', 'ah bueno', 'entendido'
      ];
      const esMensajeCasual = frasesCasual.some(frase => texto === frase || texto.startsWith(frase + ' ') || texto.endsWith(' ' + frase));
      if (esMensajeCasual || texto.length <= 3) {
        // Guardar silencio ante charlas casuales para no incomodar
        return;
      }

      // 10. DERIVACIÓN HUMANA INTELIGENTE (Preguntas libres o dudas no mapeadas)
      // Espera mínimo media hora (30 minutos) antes de volver a enviar este aviso al mismo cliente
      const ultimaVezDerivado = ultimaDerivacionMap.get(remitente) || 0;
      const mediaHoraMs = 30 * 60 * 1000;

      if (ahora - ultimaVezDerivado > mediaHoraMs) {
        ultimaDerivacionMap.set(remitente, ahora);
        const derivacion = barberia.mensajeDerivacionHumana || 
          'He tomado nota de tu consulta. En este momento el barbero está en servicio con un cliente ✂️💈. Tan pronto termine su turno te responderá personalmente por este chat.';
        
        await enviarMensajeHumano(sock, remitente, derivacion);
      }

    } catch (e) {
      console.error('Error procesando mensaje en bot:', e);
    }
}

// ----------------- CRON: ANUNCIO MATUTINO DIARIO CONFIGURABLE -----------------
const cronAnuncioMatutino = setInterval(async () => {
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
      const res = await apiBotFetch(`/bot/resumen-diario/${BARBERIA_SLUG}?fecha=${fechaIso}`);
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

// ----------------- CRON: RECORDATORIOS ANTES DE LA CITA -----------------
const cronRecordatorios = setInterval(() => {
  revisarRecordatorios().catch(err => console.error('Error en recordatorios:', err.message));
}, 5 * 60 * 1000);

if (MODO_PRUEBA) {
  clearInterval(cronAnuncioMatutino);
  clearInterval(cronRecordatorios);
} else {
  iniciarBot();
}
