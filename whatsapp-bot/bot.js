import makeWASocket, { DisconnectReason, generateMessageIDV2 } from '@whiskeysockets/baileys';
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
// Y al revés (teléfono ➔ chat @lid): los avisos que inicia el bot (cita nueva, recordatorio, reseña) deben ir
// al MISMO chat @lid donde el cliente escribe. Si se envían a su número, WhatsApp los muestra como
// "Esperando el mensaje" porque el cifrado de ese chat es otro.
const lidPorTelefono = new Map();
let almacenClavesSesion = null; // claves de la sesión de WhatsApp (PostgreSQL o archivos): ahí se guarda la relación

function digitosDeJid(jid) {
  return (jid || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
}

function recordarLid(lid, tel) {
  if (!lid || !tel) return;
  recordarTelefonoDeLid(lid, tel);
  if (lidPorTelefono.get(tel) === lid) return;
  lidPorTelefono.set(tel, lid);
  almacenClavesSesion?.set({ 'bf-lid': { [tel]: lid } }).catch(e => console.error('No se pudo guardar el chat @lid:', e.message));
}

// Solo "este @lid es este número" (para reconocer al cliente cuando escribe), sin cambiar a dónde se le envía
function recordarTelefonoDeLid(lid, tel) {
  if (!lid || !tel || telefonoPorLid.get(lid) === tel) return;
  telefonoPorLid.set(lid, tel);
  almacenClavesSesion?.set({ 'bf-tel': { [lid]: tel } }).catch(e => console.error('No se pudo guardar el número del chat @lid:', e.message));
}

async function telefonoDeLidGuardado(lid) {
  if (!lid) return '';
  if (telefonoPorLid.has(lid)) return telefonoPorLid.get(lid);
  try {
    const guardado = (await almacenClavesSesion?.get('bf-tel', [lid]))?.[lid];
    if (typeof guardado === 'string' && guardado) {
      telefonoPorLid.set(lid, guardado);
      return guardado;
    }
  } catch (e) {}
  return '';
}

// "116…@lid" o "116…" -> "116…@lid"
function normalizarLid(lid) {
  const usuario = String(lid || '').split('@')[0].split(':')[0];
  return /^\d+$/.test(usuario) ? `${usuario}@lid` : null;
}

async function lidDeTelefono(tel) {
  if (!tel) return null;
  if (lidPorTelefono.has(tel)) return lidPorTelefono.get(tel);
  try {
    const guardado = (await almacenClavesSesion?.get('bf-lid', [tel]))?.[tel];
    if (typeof guardado === 'string' && guardado.endsWith('@lid')) {
      lidPorTelefono.set(tel, guardado);
      telefonoPorLid.set(guardado, tel);
      return guardado;
    }
  } catch (e) {}
  return null;
}

function telefonoDelRemitente(key) {
  const remoteJid = key?.remoteJid || '';
  if (remoteJid.endsWith('@s.whatsapp.net')) return digitosDeJid(remoteJid);

  const senderPn = key?.senderPn || '';
  if (senderPn.endsWith('@s.whatsapp.net')) {
    const tel = digitosDeJid(senderPn);
    if (remoteJid.endsWith('@lid') && tel) recordarLid(remoteJid, tel);
    return tel;
  }

  return telefonoPorLid.get(remoteJid) || '';
}

// Igual que telefonoDelRemitente, pero si WhatsApp no manda el número (chat @lid sin senderPn)
// lo busca en lo aprendido al enviarle la confirmación de su cita (ver resolverJidDestinatario)
async function telefonoDelRemitenteAsync(key) {
  const tel = telefonoDelRemitente(key);
  if (tel) return tel;
  const remoteJid = key?.remoteJid || '';
  return remoteJid.endsWith('@lid') ? telefonoDeLidGuardado(remoteJid) : '';
}

const ultimaInteraccionCliente = new Map(); // Para saber cuándo habló por última vez
const ultimoAgradecimiento = new Map();     // Para no responder cada "gracias" del mismo chat

// Respuestas a un "gracias" (varían para que no suene a robot)
export function respuestaAgradecimiento(nombre = '', azar = Math.random()) {
  const quien = nombre ? `, ${nombre}` : '';
  const opciones = [
    `¡Con mucho gusto${quien}! 💈 Aquí estamos para lo que necesites.`,
    `¡A ti${quien}! 🙌 Cualquier cosa nos escribes por aquí.`,
    `¡Con todo el gusto${quien}! ✂️ Que tengas un excelente día.`
  ];
  return opciones[Math.floor(azar * opciones.length) % opciones.length];
}

// ----- Cuando el barbero responde a mano, el bot se calla en ese chat -----
// El bot usa el mismo WhatsApp del barbero. Si él escribe en un chat desde su celular, el bot no debe
// meterse en la conversación durante un rato (lo elige el barbero en el panel; por defecto 2 horas).
const idsDelBot = new Set();           // IDs de los mensajes que manda el bot (para no confundirlos con los del barbero)
const atencionHumana = new Map();      // chat -> cuándo escribió el barbero por última vez
export const MINUTOS_PAUSA_VALIDOS = [30, 60, 120, 240, 480, 1440];

function nuevoIdMensajeBot() {
  // Mismo formato de ID que genera Baileys; solo se recuerda cuáles fueron del bot
  const id = generateMessageIDV2(socketActivo?.user?.id);
  idsDelBot.add(id);
  if (idsDelBot.size > 5000) idsDelBot.delete(idsDelBot.values().next().value);
  return id;
}

// Todos los envíos del bot llevan un ID propio conocido
function marcarEnviosDelBot(sock) {
  const enviarOriginal = sock.sendMessage.bind(sock);
  sock.sendMessage = (jid, contenido, opciones = {}) =>
    enviarOriginal(jid, contenido, { ...opciones, messageId: opciones.messageId || nuevoIdMensajeBot() });
  return sock;
}

function marcaDeTiempoMs(msg) {
  const t = msg?.messageTimestamp;
  const seg = typeof t === 'object' && t !== null ? Number(t.low ?? t.toNumber?.() ?? 0) : Number(t || 0);
  return seg * 1000;
}

// Un mensaje "fromMe" que NO mandó el bot = el barbero escribió a mano en ese chat
export function registrarRespuestaDelBarbero(msg, ahoraMs = Date.now()) {
  const jid = msg?.key?.remoteJid || '';
  if (!jid || jid.includes('@g.us') || jid.includes('broadcast') || jid.includes('newsletter')) return false;
  if (!msg.message || msg.message.protocolMessage || msg.message.senderKeyDistributionMessage) return false;
  if (idsDelBot.has(msg.key.id)) return false;
  const cuando = marcaDeTiempoMs(msg) || ahoraMs;
  if (ahoraMs - cuando > 2 * 60 * 1000) return false; // historial viejo al reconectar

  atencionHumana.set(jid, ahoraMs);
  // El mismo cliente puede aparecer como número o como @lid: pausar los dos
  if (jid.endsWith('@lid') && telefonoPorLid.get(jid)) atencionHumana.set(`${telefonoPorLid.get(jid)}@s.whatsapp.net`, ahoraMs);
  if (jid.endsWith('@s.whatsapp.net') && lidPorTelefono.get(digitosDeJid(jid))) atencionHumana.set(lidPorTelefono.get(digitosDeJid(jid)), ahoraMs);
  estadoCliente.delete(jid);
  console.log(`[Atención humana] El barbero respondió en ${jid}: el bot no contesta en ese chat por un rato.`);
  return true;
}

function botEnPausa(jids, barberia, ahoraMs = Date.now()) {
  const minutos = MINUTOS_PAUSA_VALIDOS.includes(Number(barberia?.minutosPausaBot)) ? Number(barberia.minutosPausaBot) : 120;
  return jids.filter(Boolean).some(j => ahoraMs - (atencionHumana.get(j) || 0) < minutos * 60 * 1000);
}
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

  // Si el cliente ya nos escribió desde un chat @lid, responderle en ese mismo chat
  const lid = await lidDeTelefono(digitosDeJid(jidDirecto));
  if (lid) return lid;

  try {
    const limpio = digitosDeJid(jidDirecto);
    const res = await sock.onWhatsApp(limpio);
    if (res && res.length > 0 && res[0].exists && res[0].jid) {
      // WhatsApp también devuelve el ID anónimo (@lid) del número: así reconocemos al cliente
      // cuando responde desde un chat @lid que no trae su número (p. ej. "SI" o "CANCELAR")
      const lidCliente = normalizarLid(res[0].lid);
      if (lidCliente) {
        recordarTelefonoDeLid(lidCliente, limpio);
        // Si ya nos escribió desde ese chat @lid, la respuesta va a ese mismo chat
        if (ultimaInteraccionCliente.has(lidCliente)) {
          recordarLid(lidCliente, limpio);
          return lidCliente;
        }
      }
      return res[0].jid;
    }
  } catch (e) {
    console.log('Nota: fallback a JID directo:', e.message);
  }
  return jidDirecto;
}

// Función auxiliar para responder de forma natural (escribiendo... entre 2.5s y 4s según longitud)
// Clientes que acaban de iniciar conversación: a su primera respuesta se le antepone un saludo
const saludoPendiente = new Set();

const enviarMensajeHumano = async (sock, remitente, textoRespuesta) => {
  try {
    if (!sock || (!estaConectado && !MODO_PRUEBA && !sock.esPrueba)) return false;

    if (saludoPendiente.has(remitente)) {
      saludoPendiente.delete(remitente);
      if (!/^\s*(¡?hola|💈|☀️|¡?buen|👋)/i.test(textoRespuesta || '')) {
        textoRespuesta = `¡Hola! 👋\n\n${textoRespuesta}`;
      }
    }

    // Simular tiempo de lectura/escritura más creíble y humano:
    // Mínimo 2.5 segundos, y un poquito más si el texto es largo, con variación aleatoria humana (jitter)
    const delayBase = 2500;
    const delayExtraPorLongitud = Math.min(Math.floor((textoRespuesta || '').length * 15), 2000);
    const delayAleatorio = Math.floor(Math.random() * 800); // 0 a 800ms de variación natural
    const tiempoTotal = MODO_PRUEBA || sock.esPrueba ? 0 : delayBase + delayExtraPorLongitud + delayAleatorio; // aprox 3 a 4.5 segundos

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
async function obtenerDatosBarberia(forzar = false) {
  const ahoraTs = Date.now();
  if (forzar || !cacheBarberia || ahoraTs - ultimaCargaCache > 60000) {
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

  // 3. Webhooks desde la API (Web ➔ WhatsApp) y chat de prueba del panel
  const webhooks = {
    '/api/notificar-cita': manejarNotificarCita,
    '/api/notificar-cancelacion': manejarNotificarCancelacion,
    '/api/notificar-imprevisto': manejarNotificarImprevisto,
    '/api/notificar-cambio-hora': manejarNotificarCambioHora,
    '/api/probar': probarConversacion
  };
  const ruta = req.url.split('?')[0];
  if (req.method === 'POST' && webhooks[ruta]) {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const resultado = await webhooks[ruta](JSON.parse(body || '{}'));
        res.writeHead(resultado?.status || 200, { 'Content-Type': 'application/json' });
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

// ----------------- CÓMO ESCRIBE LA GENTE (Colombia / Medellín) -----------------

// "¡¡Holaaaa!!", "Buenaaas", "Quiubooo" -> "hola", "buenas", "quiubo" (sin tildes, sin letras alargadas ni signos)
export function normalizarTexto(texto) {
  return String(texto || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/(.)\1{2,}/g, '$1')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Intenciones sobre el texto normalizado
export const INTENCION = {
  saludo: /\b(hol+a+s?|holi+s?|ola+|alo|buen[oa]s?|buen dia|bn[ao]?s|quiubo|quihubo|kiubo|k hubo|que hubo|que mas|q mas|qmas|que hay|que hay pues|oe+|oie|ey+|hey+|epa+|ole+|saludos|info|informacion|hi|hello)\b/,
  cancelar: /\b(cancel\w*|anular|no (puedo|voy a poder|alcanzo a|podre|pude) (ir|llegar|asistir)|ya no (voy|puedo ir)|me toca cancelar)\b/,
  reagendar: /\b(reagend\w*|reprogram\w*|aplazar|cambiar (la |mi |de )?(cita|fecha|hora|horario|turno|dia)|otra hora|otro horario|correr (la |mi )?(cita|turno|hora)|mover (la |mi )?(cita|turno|hora))\b/,
  // Respuesta de confirmación: todo el mensaje es un "sí"
  confirmar: /^(si|sii|sip|sisas|sí|confirmo|confirmar|confirmado|confirmada|si confirmo|si senor|si senora|claro|claro que si|de una si|si voy|si claro|ahi estare|alla estare|ahi estoy|asistire|ahi nos vemos|listo si|si listo)$/,
  precios: /\b(precios?|cuanto (vale|valen|cuesta|cuestan|sale|salen|cobran|es|seria)|que vale|que valor|valor|tarifas?|costos?|servicios?|cortes?|lista de precios)\b/,
  reservar: /\b(reservar|reserva|agendar|separar|apartar|cupo|cupos|pedir (una )?cita|sacar (una )?cita|quiero (una )?cita|necesito (una )?cita|cita nueva|hay turno|hay cupo|tienen cupo|turno disponible)\b/,
  ubicacion: /\b(horarios?|abren|abre|cierran|cierra|atienden|abierto|abiertos|donde|direccion|ubicacion|ubicados|como llego|como llegar|mapa)\b/,
  pagos: /\b(pagos?|pagar|nequi|daviplata|bancolombia|transferencia|transferir|consignar|consignacion|efectivo|tarjeta|datafono)\b/,
  // Agradecimientos ("gracias amor", "listo, mil gracias", "Dios le pague"): el bot contesta con amabilidad
  gracias: /\b(gracias|grax|grcs|dios (le|te|les) pague|dios (le|te) bendiga|muy amable|que amable|super amable|(se|te) lo agradezco|agradecid[oa]|thanks?|thank you)\b/,
  // Reacciones sueltas: el bot no responde en medio de una conversación
  casual: /^((ja|je|ji|jo|ha)+|gracias|muchas gracias|mil gracias|dios le pague|dios te pague|ok|oki|okey|okay|vale|dale|listo|lista|melo|bacano|chevere|super|perfecto|genial|excelente|bueno|bien|esta bien|asi es|de una|entendido|ah bueno|uy|chimba|que chimba|bendiciones|igualmente)( pues| parce| mor| hermano| bro)?$/
};

const minutosATextoBot = min => {
  const h = Math.floor(min / 60), m = min % 60;
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'a. m.' : 'p. m.'}`;
};

// Aviso de hoy según los bloqueos del barbero: "Hoy no atendemos: Festivo" o "Hoy tenemos descanso: Almuerzo 12:30 – 2:00 p. m."
export function avisoDeHoy(barberia, ahoraMs = Date.now()) {
  const hoy = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date(ahoraMs));
  const deHoy = (barberia?.bloqueos || []).filter(b => b.fecha === hoy);
  const diaCompleto = deHoy.find(b => !b.hora || b.hora === 'TODO_EL_DIA');
  if (diaCompleto) return `🚫 *Hoy no atendemos*${diaCompleto.motivo ? `: ${diaCompleto.motivo}` : ''}. Puedes reservar para otro día.`;
  const [hh, mm] = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ahoraMs)).split(':').map(Number);
  const ahoraMin = hh * 60 + mm;
  const descansos = deHoy.map(b => {
    const [desde, hasta] = b.hora.includes('-') ? b.hora.split('-') : [b.hora, null];
    const ini = horaAMinutos(desde);
    if (ini === null) return null;
    const fin = hasta ? horaAMinutos(hasta) : ini + (barberia.intervaloMinutos || 40);
    if (fin <= ahoraMin) return null; // ese descanso ya pasó
    return `${b.motivo || 'Descanso'} ${minutosATextoBot(ini)} – ${minutosATextoBot(fin)}`;
  }).filter(Boolean);
  return descansos.length ? `☕ *Hoy tenemos descanso:* ${descansos.join('; ')}` : '';
}

// ----------------- TEXTOS DEL BOT -----------------

// Ícono según la categoría o el nombre del servicio (uñas 💅, barba 🧔, facial ✨, etc.)
export function iconoCategoria(texto) {
  const t = String(texto || '').toLowerCase();
  if (/uña|manicur|pedicur|nail|acrílic|acrilic|semipermanente/.test(t)) return '💅';
  if (/facial|limpieza|piel|exfolia|mascarilla|skin/.test(t)) return '✨';
  if (/barba|afeitad|bigote|perfilad/.test(t)) return '🧔';
  if (/ceja|pestaña/.test(t)) return '👁️';
  if (/tinte|color|mechas|decolora|rayitos|tintura/.test(t)) return '🎨';
  if (/masaje|spa|relaja/.test(t)) return '💆';
  if (/depila|cera/.test(t)) return '🪒';
  if (/trenza|peinad|keratina|alisad|cepillad/.test(t)) return '💇';
  if (/niñ|infantil|kids/.test(t)) return '🧒';
  if (/combo|pack|promo|paquete/.test(t)) return '👑';
  if (/corte|cabello|fade|pelo|degradad|cortes/.test(t)) return '✂️';
  return '💈';
}

// Reemplaza {cliente}, {servicio}, {fecha}... en las plantillas que el barbero edita en el panel
// Reemplaza {variables}. Una línea cuya variable quedó vacía (p. ej. "Profesional: {barbero}" sin barbero) se quita.
export function aplicarPlantilla(plantilla, datos) {
  return String(plantilla)
    .split('\n')
    .filter(linea => !(linea.match(/\{(\w+)\}/g) || []).some(v => datos[v.slice(1, -1)] === ''))
    .join('\n')
    .replace(/\{(\w+)\}/g, (todo, clave) => (datos[clave] ?? todo));
}

function mencionaConfirmar(texto) { return /\bSI\b|\bSÍ\b|CONFIRM/i.test(texto); }

function linkReservas() { return `${BASE_WEB_URL}/index.html?b=${BARBERIA_SLUG}`; }

function menuPrincipal(barberia, saludo, nombreCliente) {
  // La bienvenida del barbero se usa como saludo; sus líneas numeradas se quitan porque el bot
  // siempre muestra su menú completo (así no se pierden opciones como pagos o CANCELAR)
  const bienvenida = (barberia.mensajeBienvenidaBot || '')
    .split('\n')
    .filter(linea => !/^\s*(\d️?⃣|\d[.)-])/.test(linea))
    .join('\n')
    .trim();
  const encabezado = bienvenida
    ? aplicarPlantilla(bienvenida, { barberia: barberia.nombre, cliente: nombreCliente || '' })
    : `${saludo}\n\n¿En qué te podemos ayudar?`;
  // La gente a veces escribe "quiero cita el viernes": se aclara que se responde con un número
  return `${encabezado}\n\n` +
    `👇 *Escribe solo el número* de lo que necesitas:\n\n` +
    `*1* 📅 Reservar una cita\n` +
    `*2* 💲 Servicios y precios\n` +
    `*3* 📍 Ubicación y horario\n` +
    `*4* 💳 Formas de pago\n\n` +
    `_Por ejemplo, escribe *1* para reservar._\n` +
    `Si ya tienes una cita, escribe *CANCELAR* o *REAGENDAR*.`;
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

async function cambiarEstadoCita(citaId, estado) {
  try {
    const res = await apiBotFetch(`/bot/${BARBERIA_SLUG}/cita/${citaId}/estado`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ estado })
    });
    return res.ok;
  } catch (e) {
    console.error('[Estado cita] Error:', e.message);
    return false;
  }
}

// ¿Se prestó el servicio? Solo citas confirmadas por el cliente (o ya completadas).
// Si nunca respondió SI, queda "No Confirmada" y no se le pide opinión.
async function citaFueAtendida(citaId) {
  try {
    const res = await apiBotFetch(`/bot/${BARBERIA_SLUG}/cita/${citaId}`);
    if (!res.ok) return false;
    const cita = await res.json();
    return cita.estado === 'Confirmada' || cita.estado === 'Completada';
  } catch (e) {
    return false;
  }
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
    citaId, tokenPublico, codigoReserva, barberiaSlug, barberiaNombre, barberiaDireccion,
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

  const barberiaDatos = await obtenerDatosBarberia();
  const variables = {
    cliente: primerNombre, servicio, fecha: fechaLegible(fecha), hora, codigo: codigoReserva || '',
    barberia: barberiaNombre || barberiaDatos.nombre || '', direccion: barberiaDireccion || barberiaDatos.direccion || '',
    barbero: payload.barbero || '', valor: `${Number(total || 0).toLocaleString('es-CO')}`
  };
  const creadaPorBarbero = payload.creadaPorBarbero === true;
  const plantilla = (barberiaDatos.plantillaConfirmacion || '').trim();
  let msgPersonalizado = null;
  if (plantilla && !esReagendamiento) {
    msgPersonalizado = aplicarPlantilla(plantilla, variables);
    if (!creadaPorBarbero && !mencionaConfirmar(msgPersonalizado)) {
      msgPersonalizado += `\n\n👉 Responde *SI* para confirmar tu asistencia, o *CANCELAR* / *REAGENDAR* si no puedes.`;
    }
  }

  const msgConfirmacion = msgPersonalizado ||
    `${saludoInicial}\n\n` +
    `📋 *Detalles de tu Cita:*\n` +
    `✂️ *Servicio:* ${servicio}\n` +
    (payload.barbero ? `💈 *Barbero:* ${payload.barbero}\n` : '') +
    `📅 *Fecha:* ${fechaLegible(fecha)}\n` +
    `⏰ *Hora:* ${hora}\n` +
    `🔖 *Código:* ${codigoReserva || '#BF-CITA'}\n` +
    `💵 *Valor:* $${Number(total || 0).toLocaleString('es-CO')}\n` +
    (barberiaDireccion ? `📍 *Dirección:* ${barberiaDireccion}\n` : '') +
    `\n━━━━━━━━━━━━━━━━━━━━\n` +
    `💡 *Gestión rápida de tu cita:*\n` +
    (creadaPorBarbero ? '' : `• Responde *SI* para confirmar tu asistencia ✅\n`) +
    `• Responde *CANCELAR* si te surge un imprevisto ❌\n` +
    `• Responde *REAGENDAR* si deseas cambiar de horario 🔄\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `¡Te esperamos con la mejor atención! 💈✨`;

  const enviado = await enviarMensajeHumano(socketActivo, jid, msgConfirmacion);
  ultimaInteraccionCliente.set(jid, ahora);
  if (enviado && citaId) confirmacionEnviada.set(citaId, ahora);
  // Solo si el mensaje salió queda "Por confirmar" (si no, el cliente nunca vería la pregunta).
  // Si la anotó el barbero en el local, el cliente ya está ahí: queda Confirmada.
  if (enviado && citaId && !creadaPorBarbero) await cambiarEstadoCita(citaId, 'Pendiente');

  const encuesta = agendarEncuestaPostCita(jid, primerNombre, citaId, tokenPublico, barberiaNombre, fecha, hora, duracionMinutos);
  return { enviado: true, jid, encuestaEnMinutos: encuesta };
}

// El barbero tuvo un imprevisto: a cada cliente afectado se le avisa que su cita quedó cancelada,
// con el motivo y el enlace para elegir otra hora. Se envían en segundo plano (uno tras otro, con pausa humana).
export function mensajeImprevisto({ nombreCliente, servicio, fecha, hora }, barberiaNombre, motivoOriginal) {
  const limpio = String(motivoOriginal || '').replace(/^[^\p{L}\p{N}]+/u, '').trim();
  const motivo = /^(imprevisto|descanso.*|almuerzo|pausa.*|no disponible)$/i.test(limpio) ? '' : limpio;
  return `😔 ¡Hola ${obtenerPrimerNombre(nombreCliente)}! Te escribimos de *${barberiaNombre || 'la barbería'}*.\n\n` +
    `Por un imprevisto${motivo ? ` (${motivo})` : ''} el barbero no podrá atenderte el *${fechaLegible(fecha)}* a las *${hora}*` +
    `${servicio ? ` (${servicio})` : ''}, así que tu cita quedó cancelada. Disculpa las molestias 🙏\n\n` +
    `📅 Elige otro horario aquí:\n👉 ${linkReservas()}\n\n` +
    `El barbero también se comunicará contigo por este chat.`;
}

export async function manejarNotificarImprevisto(payload) {
  const { barberiaSlug, barberiaNombre, motivo, citas } = payload || {};
  if (barberiaSlug && barberiaSlug.toLowerCase() !== BARBERIA_SLUG.toLowerCase()) {
    return { enviado: false, razon: 'Aviso de otra barbería' };
  }
  if (!socketActivo || (!estaConectado && !MODO_PRUEBA)) return { enviado: false, razon: 'Bot no conectado' };
  const lista = (Array.isArray(citas) ? citas : []).filter(c => c?.telefonoCliente);

  const enviarTodos = async () => {
    const enviados = [];
    for (const c of lista) {
      try {
        const jid = await resolverJidDestinatario(socketActivo, c.telefonoCliente);
        if (await enviarMensajeHumano(socketActivo, jid, mensajeImprevisto(c, barberiaNombre, motivo))) enviados.push(c.id);
      } catch (e) {
        console.error('[Imprevisto] No se pudo avisar a', c.nombreCliente, e.message);
      }
    }
    console.log(`[Imprevisto] Avisados ${enviados.length} de ${lista.length} clientes.`);
    return enviados;
  };
  // En pruebas se espera; en producción se responde de una vez y se envía en segundo plano
  if (MODO_PRUEBA) return { enviado: true, enviados: await enviarTodos() };
  enviarTodos();
  return { enviado: true, programados: lista.length };
}

// El barbero corrió esta cita para atender a alguien en el local: se le avisa la nueva hora
// y, si no le sirve, el enlace para elegir otra.
export function mensajeCambioHora({ nombreCliente, servicio, fecha, horaAnterior, horaNueva, tokenPublico }, barberiaNombre, ahoraMs = Date.now()) {
  const hoy = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date(ahoraMs));
  const cuando = fecha === hoy ? 'de hoy' : `del ${fechaLegible(fecha)}`;
  const enlace = tokenPublico
    ? `${BASE_WEB_URL}/index.html?b=${encodeURIComponent(BARBERIA_SLUG)}&reagendar=${encodeURIComponent(tokenPublico)}`
    : linkReservas();
  return `⏰ ¡Hola ${obtenerPrimerNombre(nombreCliente)}! Te escribimos de *${barberiaNombre || 'la barbería'}*.\n\n` +
    `Tuvimos un ajuste en la agenda y tu cita ${cuando}${servicio ? ` (${servicio})` : ''} se corrió un poquito:\n\n` +
    `🕒 Antes: ~${horaAnterior}~\n` +
    `✅ Ahora: *${horaNueva}*\n\n` +
    `Si la nueva hora no te sirve, elige otra aquí:\n👉 ${enlace}\n\n` +
    `¡Gracias por tu paciencia! 🙏`;
}

export async function manejarNotificarCambioHora(payload) {
  const { barberiaSlug, barberiaNombre, citas } = payload || {};
  if (barberiaSlug && barberiaSlug.toLowerCase() !== BARBERIA_SLUG.toLowerCase()) {
    return { enviado: false, razon: 'Aviso de otra barbería' };
  }
  if (!socketActivo || (!estaConectado && !MODO_PRUEBA)) return { enviado: false, razon: 'Bot no conectado' };
  const lista = (Array.isArray(citas) ? citas : []).filter(c => c?.telefonoCliente);
  const enviarTodos = async () => {
    const enviados = [];
    for (const c of lista) {
      try {
        const jid = await resolverJidDestinatario(socketActivo, c.telefonoCliente);
        if (await enviarMensajeHumano(socketActivo, jid, mensajeCambioHora(c, barberiaNombre))) enviados.push(c.id);
      } catch (e) {
        console.error('[Cambio de hora] No se pudo avisar a', c.nombreCliente, e.message);
      }
    }
    return enviados;
  };
  if (MODO_PRUEBA) return { enviado: true, enviados: await enviarTodos() };
  enviarTodos();
  return { enviado: true, programados: lista.length };
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
// El enlace usa el token público de la cita (no el Id secuencial, que permitiría ver/calificar citas ajenas).
export function urlCalificarCita(tokenPublico) {
  return `${BASE_WEB_URL}/index.html?b=${encodeURIComponent(BARBERIA_SLUG)}&calificar=${encodeURIComponent(tokenPublico)}`;
}

function agendarEncuestaPostCita(jid, primerNombre, citaId, tokenPublico, barberiaNombre, fecha, hora, duracionMinutos) {
  const inicio = instanteCita(fecha, hora);
  if (!inicio || !citaId || !tokenPublico) return null;
  const envio = inicio + ((Number(duracionMinutos) || 40) + 60) * 60 * 1000;
  const espera = envio - Date.now();
  if (espera < 0 || espera > MAX_ESPERA_MS) return null;

  setTimeout(async () => {
    try {
      if (!socketActivo || !estaConectado) return;
      if ((await obtenerDatosBarberia()).pedirOpinionActivo === false) return; // el barbero lo apagó en el panel
      if (!await citaFueAtendida(citaId)) return; // sin confirmar, cancelada o reagendada: no pedir reseña
      const urlCalificar = urlCalificarCita(tokenPublico);
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

// Recordatorios automáticos: el barbero elige en el panel uno o varios momentos (2 días, 1 día, 12, 6, 3, 2 o 1 hora antes).
// Se apagan desde el panel o con RECORDATORIOS_ACTIVOS=0. Se recuerda en memoria qué recordatorio de cada cita ya salió.
const HORAS_RECORDATORIO_VALIDAS = [48, 24, 12, 6, 3, 2, 1];
const recordatoriosEnviados = new Set(); // "citaId:horas"
const confirmacionEnviada = new Map();   // citaId -> cuándo se le mandó la confirmación de la reserva

export function horasDeRecordatorio(barberia) {
  const lista = String(barberia?.horasRecordatorios ?? '').split(',').map(Number).filter(h => HORAS_RECORDATORIO_VALIDAS.includes(h));
  if (lista.length) return [...new Set(lista)].sort((a, b) => b - a);
  const una = Number(barberia?.horasRecordatorio);
  return [HORAS_RECORDATORIO_VALIDAS.includes(una) ? una : 2];
}

export async function revisarRecordatorios(ahoraMs = Date.now()) {
  if (process.env.RECORDATORIOS_ACTIVOS === '0') return [];
  if (!socketActivo || (!estaConectado && !MODO_PRUEBA)) return [];

  for (const [id, cuando] of confirmacionEnviada) if (ahoraMs - cuando > 3 * 24 * 3600 * 1000) confirmacionEnviada.delete(id);
  const barberiaDatos = await obtenerDatosBarberia();
  if (barberiaDatos.recordatoriosActivos === false) return [];
  const listaHoras = horasDeRecordatorio(barberiaDatos);
  const masLejano = Math.max(...listaHoras);

  const fechaCo = ms => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date(ms));
  const hoy = fechaCo(ahoraMs);
  const manana = fechaCo(ahoraMs + 86400000);
  // Días a revisar: hoy y los siguientes que alcance el recordatorio más lejano
  const fechas = [hoy];
  for (let d = 1; d <= Math.ceil((masLejano + 1) / 24); d++) fechas.push(fechaCo(ahoraMs + d * 86400000));
  const enviados = [];

  for (const fechaIso of fechas) {
    const res = await apiBotFetch(`/bot/resumen-diario/${BARBERIA_SLUG}?fecha=${fechaIso}`);
    if (!res.ok) continue;
    const data = await res.json();
    const cuando = fechaIso === hoy ? 'de hoy' : fechaIso === manana ? 'de mañana' : `del ${fechaLegible(fechaIso)}`;

    for (const c of data.citas || []) {
      if (!['Confirmada', 'Pendiente'].includes(c.estado) || !c.telefonoCliente) continue;
      const inicio = instanteCita(fechaIso, c.hora);
      if (!inicio) continue;
      const minutosFaltan = (inicio - ahoraMs) / 60000;
      // ¿Toca alguno de los recordatorios elegidos? Se envía cuando faltan como máximo esas horas
      // (p. ej. "2 horas antes" sale entre 2:00 y 1:00 antes; con la revisión cada 5 min, a las ~2 h justas)
      const horas = listaHoras.find(h => minutosFaltan <= h * 60 && minutosFaltan > h * 60 - 60);
      if (!horas || recordatoriosEnviados.has(`${c.id}:${horas}`)) continue;
      // Si acaba de reservar (le llegó la confirmación hace menos de 1 h y media), no recordarle todavía
      const desdeConfirmacion = ahoraMs - (confirmacionEnviada.get(c.id) ?? -Infinity);
      if (desdeConfirmacion >= 0 && desdeConfirmacion < 90 * 60 * 1000) continue;

      recordatoriosEnviados.add(`${c.id}:${horas}`);
      const jid = await resolverJidDestinatario(socketActivo, c.telefonoCliente);
      const plantillaRec = (barberiaDatos.plantillaRecordatorio || '').trim();
      if (plantillaRec) {
        let texto = aplicarPlantilla(plantillaRec, {
          cliente: obtenerPrimerNombre(c.nombreCliente), servicio: c.servicio, fecha: fechaLegible(fechaIso), hora: c.hora,
          codigo: c.codigoReserva || '', barberia: data.nombre || '', direccion: barberiaDatos.direccion || '', barbero: c.barbero || ''
        });
        if (c.estado === 'Pendiente' && !mencionaConfirmar(texto)) texto += `\n\n👉 Responde *SI* para confirmar que vienes.`;
        await enviarMensajeHumano(socketActivo, jid, texto);
        enviados.push(c.id);
        continue;
      }
      await enviarMensajeHumano(
        socketActivo,
        jid,
        `⏰ ¡Hola ${obtenerPrimerNombre(c.nombreCliente)}! Te recordamos tu cita ${cuando} en *${data.nombre || 'la barbería'}*:\n\n` +
        `✂️ *Servicio:* ${c.servicio}\n` +
        (fechaIso === hoy ? '' : `📅 *Fecha:* ${fechaLegible(fechaIso)}\n`) +
        `🕒 *Hora:* ${c.hora}\n\n` +
        (c.estado === 'Pendiente'
          ? `👉 Responde *SI* para confirmar que vienes, o *CANCELAR* / *REAGENDAR* si no puedes. 💈`
          : `Por favor llega 5 minutos antes. Si no puedes asistir, responde *CANCELAR* o *REAGENDAR*. 💈`)
      );
      enviados.push(c.id);
    }
  }
  return enviados;
}

// ----------------- CHAT DE PRUEBA DEL PANEL -----------------
// El barbero escribe en el panel como si fuera un cliente nuevo y ve lo que respondería el bot.
// Nada sale por WhatsApp: las respuestas se capturan con un socket falso. Funciona aunque el bot no esté vinculado.
const JID_CHAT_PRUEBA = 'chat-de-prueba-del-panel@lid';
export async function probarConversacion({ slug, texto, reiniciar } = {}) {
  if (!slug || String(slug).toLowerCase() !== BARBERIA_SLUG.toLowerCase()) {
    return { status: 403, error: 'Este bot atiende otra barbería.' };
  }
  if (reiniciar) {
    ultimaInteraccionCliente.delete(JID_CHAT_PRUEBA);
    estadoCliente.delete(JID_CHAT_PRUEBA);
    saludoPendiente.delete(JID_CHAT_PRUEBA);
    ultimaDerivacionMap.delete(JID_CHAT_PRUEBA);
  }
  const mensaje = String(texto || '').slice(0, 500).trim();
  if (!mensaje) return { respuestas: [] };

  await obtenerDatosBarberia(true);
  const respuestas = [];
  const sockPrueba = {
    esPrueba: true,
    sendMessage: async (jid, contenido) => { if (jid === JID_CHAT_PRUEBA && contenido?.text) respuestas.push(contenido.text); },
    sendPresenceUpdate: async () => {},
    onWhatsApp: async () => []
  };
  await procesarMensajeEntrante(sockPrueba, {
    type: 'notify',
    messages: [{ key: { remoteJid: JID_CHAT_PRUEBA, fromMe: false, id: `PRUEBA${Date.now()}` }, message: { conversation: mensaje } }]
  });
  return { respuestas, botActivo: cacheBarberia?.botActivo !== false };
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
  almacenClavesSesion = state.keys;
  const sock = marcarEnviosDelBot(makeWASocket({ auth: state, printQRInTerminal: false }));
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
      if (!m.messages || m.messages.length === 0) return;
      const msg = m.messages[0];
      if (!msg.message) return;

      // ¿Lo escribió el barbero desde su celular? Entonces el bot se calla un rato en ese chat
      if (msg.key?.fromMe) {
        registrarRespuestaDelBarbero(msg);
        return;
      }

      // Solo mensajes nuevos: al reconectar llegan mensajes de historial (type 'append') que no se deben contestar
      if (m.type && m.type !== 'notify') return;

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
      // Versión sin tildes ni letras alargadas ("Holaaa", "Quiubooo", "Buenaaas") para reconocer cómo escribe la gente
      const textoN = normalizarTexto(texto);

      const ahora = Date.now();
      // ¿Empieza una conversación? (primer mensaje, o más de 6 horas sin escribir)
      const esInicioConversacion = ahora - (ultimaInteraccionCliente.get(remitente) || 0) > 6 * 60 * 60 * 1000;
      ultimaInteraccionCliente.set(remitente, ahora);
      if (esInicioConversacion) {
        estadoCliente.delete(remitente);   // no arrastrar menús viejos
        saludoPendiente.add(remitente);    // la primera respuesta arranca con un saludo
      }
      // Una opción de menú solo cuenta si el mensaje es únicamente el número ("4", "4.", "4️⃣").
      // Así "a las 3 tienen cupo?" no abre por error la opción 3.
      const coincideOpcion = texto.match(/^\s*(\d{1,2})\s*(️?⃣)?\s*[.)]?\s*$/);
      const soloNumeros = coincideOpcion ? coincideOpcion[1] : '';

      const barberia = await obtenerDatosBarberia();
      if (barberia.botActivo === false) return;

      // Extraer número de teléfono del remitente (ej: 17747126594@s.whatsapp.net o 573024084425@s.whatsapp.net)
      const telSoloDigitos = await telefonoDelRemitenteAsync(msg.key);
      const ultimos10 = telSoloDigitos.length >= 10 ? telSoloDigitos.slice(-10) : telSoloDigitos;
      const telBusqueda = telSoloDigitos;

      console.log(`[Mensaje Recibido] De: ${remitente} | Tel: ${telSoloDigitos || '(desconocido)'} | Texto: ${texto}`);
      if (!telSoloDigitos) {
        console.warn(`[Aviso] No se pudo obtener el número real de ${remitente} (sin senderPn).`);
      }

      // El barbero está hablando personalmente con este cliente: no interrumpir
      if (!sock.esPrueba && botEnPausa([remitente, telSoloDigitos && `${telSoloDigitos}@s.whatsapp.net`, telSoloDigitos && lidPorTelefono.get(telSoloDigitos)], barberia)) {
        saludoPendiente.delete(remitente);
        console.log(`[Atención humana] ${remitente} escribió, pero el barbero está atendiendo ese chat: el bot no responde.`);
        return;
      }

      const estado = estadoCliente.get(remitente) || { nivel: 'INICIO' };

      // Saludo de bienvenida con el menú (personalizado si ya es cliente)
      const saludarConMenu = async (notaFinal = '') => {
        estadoCliente.set(remitente, { nivel: 'INICIO' });
        let saludoPersonalizado = `💈 *¡Hola! Bienvenido a ${barberia.nombre || 'la barbería'}*`;
        let nombreConocido = '';
        if (telBusqueda) try {
          const resCli = await apiBotFetch(`/bot/${BARBERIA_SLUG}/citas-cliente/${telBusqueda}`);
          if (resCli.ok) {
            const datosCita = await resCli.json();
            if (datosCita && datosCita.nombreCliente) {
              nombreConocido = obtenerPrimerNombre(datosCita.nombreCliente);
              saludoPersonalizado = `💈 *¡Hola ${nombreConocido}! Qué gusto verte de nuevo en ${barberia.nombre || 'la barbería'}*`;
            }
          }
        } catch (e) {}
        // Si hoy el barbero no atiende o tiene un descanso, se avisa de una vez con el motivo
        const aviso = avisoDeHoy(barberia);
        const menu = menuPrincipal(barberia, saludoPersonalizado, nombreConocido) + (aviso ? `\n\n${aviso}` : '');
        await enviarMensajeHumano(sock, remitente, notaFinal ? `${menu}\n\n${notaFinal}` : menu);
      };

      // Si la conversación empieza con solo un número ("4"), primero se saluda y se muestran las opciones
      if (esInicioConversacion && soloNumeros) {
        await saludarConMenu();
        return;
      }

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
              `✅ ¡Listo ${nombreCliente}! Tu cita para el *${fechaLegible(estado.citaFecha)} a las ${estado.citaHora}* ha sido cancelada correctamente.\n\n` +
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
                  `El cliente *${nombreCliente}* canceló su turno del *${fechaLegible(estado.citaFecha)}* a las *${estado.citaHora}*.\n\n` +
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
              `👍 ¡Perfecto! Tu cita para el *${fechaLegible(estado.citaFecha)} a las ${estado.citaHora}* sigue firme y reservada. ¡Te esperamos! 💈✂️`
            );
            return;
          }

          // Respuesta ambigua: volver a preguntar en lugar de seguir con otros flujos
          await enviarMensajeHumano(
            sock,
            remitente,
            `Para confirmar, responde *1* si deseas *cancelar* tu cita del *${fechaLegible(estado.citaFecha)} a las ${estado.citaHora}*, o *2* si prefieres *mantenerla*. ✂️`
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
      if (texto.includes('cancelar') || texto.includes('cancelo') || INTENCION.cancelar.test(textoN)) {
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
              `Hola ${primerNombre}, encontramos tu cita:\n\n` +
              `${iconoCategoria(cita.servicio)} *${cita.servicio}*\n` +
              `📅 ${fechaLegible(cita.fecha)}\n` +
              `⏰ ${cita.hora}\n` +
              `🔖 ${cita.codigoReserva}\n\n` +
              `¿Seguro que quieres cancelarla?\n\n` +
              `*1.* Sí, cancelar ❌\n` +
              `*2.* No, mantener mi cita ✅`;

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
      if (texto.includes('reagendar') || INTENCION.reagendar.test(textoN)) {
        try {
          const cita = await buscarCitaClienteAsync();
          let urlReagendar = `${BASE_WEB_URL}/index.html?b=${BARBERIA_SLUG}`;
          let detalle = '';

          // Sin cita activa no hay nada que cambiar: ofrecer reservar una nueva
          if (!cita || !cita.tokenPublico) {
            await enviarMensajeHumano(sock, remitente,
              `No encontramos una cita activa con este número para cambiar.\n\n` +
              `📅 Si quieres, reserva una nueva aquí:\n👉 ${linkReservas()}`);
            return;
          }

          if (cita && cita.tokenPublico) {
            urlReagendar = `${BASE_WEB_URL}/index.html?b=${BARBERIA_SLUG}&reagendar=${encodeURIComponent(cita.tokenPublico)}`;
            detalle = ` de tu cita (*${cita.servicio}*, ${fechaLegible(cita.fecha)} a las ${cita.hora})`;
          }

          const msjReagendar =
            `🔄 *Cambiar tu cita*\n\n` +
            `Para elegir un nuevo día y hora${detalle}, entra aquí:\n` +
            `👉 ${urlReagendar}\n\n` +
            `_Cuando elijas el nuevo horario, tu cita anterior se libera sola._`;

          await enviarMensajeHumano(sock, remitente, msjReagendar);
          return;
        } catch (e) {}
      }

      // 3. CONFIRMACIÓN DE ASISTENCIA ("si", "confirmo", "asistiré"...): la cita pasa a Confirmada
      if (INTENCION.confirmar.test(textoN)) {
        const cita = await buscarCitaClienteAsync();
        if (!cita) {
          await enviarMensajeHumano(sock, remitente, telSoloDigitos
            ? `No encontramos una cita pendiente con este número. Si quieres reservar, entra aquí:\n👉 ${linkReservas()}`
            : `😕 No pudimos identificar tu número de WhatsApp para buscar tu cita. El barbero te ayudará personalmente por este chat en cuanto pueda.`);
          return;
        }
        const nombre = obtenerPrimerNombre(cita.nombreCliente);
        const yaConfirmada = cita.estado === 'Confirmada';
        if (!yaConfirmada) await cambiarEstadoCita(cita.id, 'Confirmada');
        await enviarMensajeHumano(sock, remitente,
          `${yaConfirmada ? `¡Tu cita ya estaba confirmada, ${nombre}!` : `¡Listo ${nombre}! Tu cita quedó *confirmada* ✅`}\n\n` +
          `${iconoCategoria(cita.servicio)} ${cita.servicio}\n📅 ${fechaLegible(cita.fecha)} a las ${cita.hora}\n\n` +
          `¡Te esperamos! 💈`);
        return;
      }

      // Agrupar categorías de servicios
      const serviciosLista = barberia.servicios || [];
      const categoriasMap = new Map();
      serviciosLista.forEach(s => {
        const cat = (s.categoria || '').trim() || 'Servicios';
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
        await enviarMensajeHumano(sock, remitente, menuPrincipal(barberia, `💈 *${barberia.nombre || 'Bienvenido'}*`));
        return;
      }

      // SUBMENÚ DE CATEGORÍAS DE SERVICIOS
      if (estado.nivel === 'SERVICIOS') {
        const opcionCatIndex = parseInt(soloNumeros, 10) - 1;
        if (!isNaN(opcionCatIndex) && opcionCatIndex >= 0 && opcionCatIndex < categoriasNombres.length) {
          const catSeleccionada = categoriasNombres[opcionCatIndex];
          const serviciosCat = categoriasMap.get(catSeleccionada) || [];

          let lista = `${iconoCategoria(catSeleccionada)} *${catSeleccionada}*\n\n`;
          serviciosCat.forEach(s => {
            lista += `${iconoCategoria(s.nombre + ' ' + catSeleccionada)} *${s.nombre}*\n`;
            lista += `     $ ${Number(s.precio).toLocaleString('es-CO')} · ${s.duracionMinutos || 30} min\n`;
            if (s.descripcion) lista += `     _${String(s.descripcion).slice(0, 80)}_\n`;
            lista += `\n`;
          });
          lista += `📅 Reserva aquí: ${linkReservas()}\n\n`;
          lista += `_Responde otro número para ver otra categoría, o *0* para el menú._`;

          await enviarMensajeHumano(sock, remitente, lista);
          return;
        }
      }

      // 5. Precios y Servicios (Abrir submenú de categorías)
      if (
        soloNumeros === '2' ||
        INTENCION.precios.test(textoN)
      ) {
        estadoCliente.set(remitente, { nivel: 'SERVICIOS' });

        if (!categoriasNombres.length) {
          await enviarMensajeHumano(sock, remitente, `Puedes ver todos nuestros servicios y precios aquí:\n👉 ${linkReservas()}`);
          return;
        }
        let menuServicios = `💲 *Servicios y precios*\n\nElige una categoría:\n\n`;
        categoriasNombres.forEach((cat, index) => {
          menuServicios += `*${index + 1}.* ${iconoCategoria(cat)} ${cat}\n`;
        });
        menuServicios += `\n*0.* Volver al menú`;

        await enviarMensajeHumano(sock, remitente, menuServicios);
        return;
      }

      // 6a. Opción 1: reservar (enlace directo, sin repetir el menú)
      if (soloNumeros === '1' || INTENCION.reservar.test(textoN)) {
        estadoCliente.set(remitente, { nivel: 'INICIO' });
        await enviarMensajeHumano(sock, remitente,
          `📅 *Reserva tu cita en línea*\n\nLas citas se apartan en este enlace: ahí eliges el servicio, el día y la hora que estén libres (toma menos de un minuto):\n👉 ${linkReservas()}\n\n` +
          `Te llegará la confirmación por este chat. ✅`);
        return;
      }

      // 6. Saludos / Menú principal
      if (INTENCION.saludo.test(textoN) && !INTENCION.gracias.test(textoN)) {
        await saludarConMenu();
        return;
      }

      // 7. Ubicación / Dónde quedan
      if (
        soloNumeros === '3' ||
        INTENCION.ubicacion.test(textoN)
      ) {
        const mapa = barberia.direccion
          ? `\n🗺️ https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${barberia.nombre} ${barberia.direccion}`)}`
          : '';
        const ubi = `📍 *Dónde estamos*\n\n` +
          `${barberia.direccion || 'Escríbenos y te compartimos la ubicación.'}${mapa}\n\n` +
          (barberia.horarioTexto ? `🕘 *Horario:* ${barberia.horarioTexto}\n\n` : '') +
          (avisoDeHoy(barberia) ? `${avisoDeHoy(barberia)}\n\n` : '') +
          `📅 Reserva y evita la fila: ${linkReservas()}\n\n` +
          `_Responde *0* para volver al menú._`;
        await enviarMensajeHumano(sock, remitente, ubi);
        return;
      }

      // 8. Métodos de Pago
      if (
        soloNumeros === '4' ||
        INTENCION.pagos.test(textoN)
      ) {
        let msgPago = `💳 *Formas de pago*\n\n`;
        msgPago += `💵 *Efectivo:* en el local al terminar tu servicio.\n`;

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

        msgPago += `\n📅 Reserva aquí: ${linkReservas()}\n\n`;
        msgPago += `_Responde *0* para volver al menú._`;

        await enviarMensajeHumano(sock, remitente, msgPago);
        return;
      }

      // 8b. AGRADECIMIENTOS: una respuesta amable (máximo una cada 30 minutos por chat, para no ser cansón)
      if (INTENCION.gracias.test(textoN) && textoN.length <= 60) {
        saludoPendiente.delete(remitente);
        if (ahora - (ultimoAgradecimiento.get(remitente) || 0) > 30 * 60 * 1000) {
          ultimoAgradecimiento.set(remitente, ahora);
          const cita = telSoloDigitos ? await buscarCitaClienteAsync() : null;
          await enviarMensajeHumano(sock, remitente, respuestaAgradecimiento(cita ? obtenerPrimerNombre(cita.nombreCliente) : ''));
        }
        return;
      }

      // 9. FILTRO INTELIGENTE DE MENSAJES CASUALES / DESPEDIDAS / RISAS
      // Si el mensaje es una reacción informal, despedida o risa, el bot guarda silencio como un humano
      const esMensajeCasual = INTENCION.casual.test(textoN);
      if (esMensajeCasual || textoN.length <= 3) {
        // Al empezar la conversación se saluda; en medio de ella, silencio ante charlas casuales
        if (esInicioConversacion) await saludarConMenu();
        return;
      }

      // Primer mensaje que el bot no entiende: saludo con opciones y aviso de que el barbero responderá
      if (esInicioConversacion) {
        ultimaDerivacionMap.set(remitente, ahora);
        await saludarConMenu('Si tu consulta es otra, el barbero te responderá personalmente por aquí apenas pueda. 🙌');
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
    } finally {
      // Si no hubo respuesta (silencio), que el saludo pendiente no se cuele en un aviso posterior
      const jid = m?.messages?.[0]?.key?.remoteJid;
      if (jid) saludoPendiente.delete(jid);
    }
}

// ----------------- ANUNCIO MATUTINO DIARIO PARA EL BARBERO -----------------
// Se envía a partir de la hora configurada (y hasta 3 horas después, por si el bot estaba reiniciando).
export function armarAnuncioMatutino(data) {
  const citas = (data.citas || []).filter(c => c.estado === 'Confirmada' || c.estado === 'Pendiente');
  let texto = `☀️ *Buenos días, ${data.nombre}*\n${capitalizar(fechaLegible(data.fecha))}\n\n`;

  if (!citas.length) {
    texto += `Hoy no tienes citas reservadas por ahora.\n\n` +
      `Comparte tu enlace para llenar la agenda:\n👉 ${linkReservas()}`;
    return texto;
  }

  const porConfirmar = citas.filter(c => c.estado === 'Pendiente').length;
  const total = citas.reduce((suma, c) => suma + Number(c.total || 0), 0);
  texto += `📋 *${citas.length} cita${citas.length === 1 ? '' : 's'} hoy*` +
    (porConfirmar ? ` (${porConfirmar} por confirmar)` : '') + `\n\n`;

  citas.forEach(c => {
    texto += `${c.estado === 'Pendiente' ? '⏳' : '✅'} *${c.hora}* · ${c.nombreCliente}\n` +
      `      ${iconoCategoria(c.servicio)} ${c.servicio}\n`;
  });

  texto += `\n💰 Ingreso estimado: *$ ${total.toLocaleString('es-CO')}*\n`;
  if (porConfirmar) texto += `⏳ = el cliente aún no confirma; si no lo hace antes de la hora, la cita se libera sola.\n`;
  texto += `\n📲 Tu agenda: ${BASE_WEB_URL}/admin.html`;
  return texto;
}

function capitalizar(t) { return t ? t.charAt(0).toUpperCase() + t.slice(1) : t; }

export async function revisarAnuncioMatutino(ahoraMs = Date.now()) {
  if (!socketActivo || (!estaConectado && !MODO_PRUEBA)) return null;

  const fecha = new Date(ahoraMs);
  const fechaIso = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(fecha);
  if (ultimoDiaAnuncioEnviado === fechaIso) return null;

  const barberia = await obtenerDatosBarberia();
  if (!barberia.anuncioMatutinoActivo) return null;

  const partes = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short'
  }).formatToParts(fecha).map(p => [p.type, p.value]));
  const minutosAhora = (Number(partes.hour) % 24) * 60 + Number(partes.minute);
  const objetivo = partes.weekday === 'Sat' ? (barberia.horaAnuncioSabado || '08:00')
    : partes.weekday === 'Sun' ? (barberia.horaAnuncioDomingo || '09:00')
    : (barberia.horaAnuncioSemana || '08:00');
  const minutosObjetivo = horaAMinutos(objetivo);
  if (minutosObjetivo === null || minutosAhora < minutosObjetivo || minutosAhora > minutosObjetivo + 180) return null;

  const res = await apiBotFetch(`/bot/resumen-diario/${BARBERIA_SLUG}?fecha=${fechaIso}`);
  if (!res.ok) return null;
  const data = await res.json();
  const jidBarbero = formatearJidWhatsApp(data.telefonoWhatsApp);
  if (!jidBarbero) return null;

  const texto = armarAnuncioMatutino(data);
  await enviarMensajeHumano(socketActivo, jidBarbero, texto);
  ultimoDiaAnuncioEnviado = fechaIso;
  console.log(`[Anuncio Matutino Enviado] ${fechaIso}`);
  return texto;
}

const cronAnuncioMatutino = setInterval(() => {
  revisarAnuncioMatutino().catch(err => console.error('Error en anuncio matutino:', err.message));
}, 60 * 1000);

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
