import makeWASocket, { DisconnectReason, generateMessageIDV2, DEFAULT_CONNECTION_CONFIG, proto } from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import http from 'http';
import fetch from 'node-fetch';
import crypto from 'crypto';
import { crearAlmacenSesion } from './auth-postgres.js';

// BOT_PORT: cuando el bot corre dentro del mismo servicio que la API (PORT es el de la API)
const PORT = process.env.BOT_PORT || process.env.PORT || 3001;
const API_BASE_URL = process.env.BARBERFLOW_API_URL || 'https://barberflow-aos9.onrender.com/api/public';
const BARBERIA_SLUG = process.env.BARBERIA_SLUG || 'barberia-jr';
const BASE_WEB_URL = (process.env.BARBERFLOW_WEB_URL || 'https://barberflow-aos9.onrender.com').replace(/\/+$/, '');
const HOST_WEB = (() => { try { return new URL(BASE_WEB_URL).host.toLowerCase(); } catch { return 'barberflow'; } })();
// Clave compartida con la API (misma variable BOT_API_KEY en ambos servicios de Render)
const BOT_API_KEY = process.env.BOT_API_KEY || '';
if (!BOT_API_KEY) {
  console.warn('⚠️ BOT_API_KEY no está definida: la API rechazará las consultas del bot y los webhooks quedarán cerrados.');
}

// fetch hacia los endpoints /bot/* de la API, siempre con la clave del bot
function apiBotFetch(ruta, opciones = {}) {
  return fetch(`${API_BASE_URL}${ruta}`, {
    signal: AbortSignal.timeout(15000),
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
// Con varias barberías, gestor.js arranca una copia de este bot por barbería (BOT_HIJO=1).
// Si este archivo se ejecuta directo (node bot.js), le cede el control al gestor.
// BOT_UNICO=1 conserva el modo antiguo: un solo bot para BARBERIA_SLUG.
const MODO_GESTOR = !MODO_PRUEBA && process.env.BOT_HIJO !== '1' && process.env.BOT_UNICO !== '1';

// WhatsApp puede identificar al cliente con un ID anónimo (…@lid) en lugar de su número.
// Desde Baileys 7 la relación @lid ↔ número la guarda la propia librería en la sesión (claves "lid-mapping",
// en PostgreSQL junto con el resto de la sesión): la aprende de cada mensaje que llega y de las consultas a
// WhatsApp. Se consulta con sock.signalRepository.lidMapping. Aquí solo queda una copia en memoria para las
// consultas rápidas (la pausa del bot cubre el chat @lid y el del número del mismo cliente).
// Los avisos que inicia el bot (cita nueva, recordatorio, reseña) van al chat @lid del cliente: es donde él
// escribe, y si se envían a su número WhatsApp los muestra como "Esperando el mensaje".
const telefonoPorLid = new Map(); // "116…@lid" -> "57300…"
const lidPorTelefono = new Map(); // "57300…" -> "116…@lid"
let almacenClavesSesion = null; // claves de la sesión de WhatsApp (PostgreSQL o archivos): ahí guarda el bot sus marcas "bf-…"

function digitosDeJid(jid) {
  return (jid || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
}

// "116…@lid", "116…:3@lid" o "116…" -> "116…@lid"
function normalizarLid(lid) {
  const texto = String(lid || '');
  if (texto.includes('@') && !texto.endsWith('@lid')) return null;
  const usuario = texto.split('@')[0].split(':')[0];
  return /^\d+$/.test(usuario) ? `${usuario}@lid` : null;
}

function recordarLid(lid, tel) {
  lid = normalizarLid(lid);
  if (!lid || !tel) return;
  if (telefonoPorLid.size > 20000) { telefonoPorLid.clear(); lidPorTelefono.clear(); }
  telefonoPorLid.set(lid, tel);
  lidPorTelefono.set(tel, lid);
}

// El almacén de Baileys con la relación @lid ↔ número (no existe en los sockets falsos de las pruebas del panel)
function mapeoLid(sock) {
  return sock?.signalRepository?.lidMapping || null;
}

// Número del cliente que escribió, sin consultar nada: el que trae el mensaje o el que ya se sabe
function telefonoDelRemitente(key) {
  const remoteJid = key?.remoteJid || '';
  if (remoteJid.endsWith('@s.whatsapp.net')) return digitosDeJid(remoteJid);
  // En un chat @lid, Baileys 7 trae el número del cliente en remoteJidAlt (en la 6.x era senderPn).
  // En los mensajes del propio barbero (fromMe) ese campo no es el número del cliente: no se usa.
  const alterno = key?.fromMe ? '' : String(key?.remoteJidAlt || '');
  if (remoteJid.endsWith('@lid') && alterno.endsWith('@s.whatsapp.net')) {
    const tel = digitosDeJid(alterno);
    if (tel) recordarLid(remoteJid, tel);
    return tel;
  }
  return telefonoPorLid.get(normalizarLid(remoteJid)) || '';
}

// Igual que telefonoDelRemitente, pero si el mensaje no trae el número (chat @lid sin remoteJidAlt)
// lo busca en lo que Baileys ya aprendió (p. ej. al enviarle la confirmación de su cita)
async function telefonoDelRemitenteAsync(sock, key) {
  const tel = telefonoDelRemitente(key);
  if (tel) return tel;
  const remoteJid = String(key?.remoteJid || '');
  const mapeo = mapeoLid(sock);
  if (!remoteJid.endsWith('@lid') || !mapeo) return '';
  try {
    const encontrado = digitosDeJid(await mapeo.getPNForLID(normalizarLid(remoteJid)));
    if (encontrado) {
      recordarLid(remoteJid, encontrado);
      return encontrado;
    }
  } catch (e) {
    console.warn(`No se pudo buscar el número del chat ${remoteJid}:`, e.message);
  }
  return '';
}

// Chat @lid de un número: lo que ya se sabe o, si no, Baileys le pregunta a WhatsApp (y lo deja guardado)
async function lidDeTelefono(sock, tel) {
  if (!tel) return null;
  if (lidPorTelefono.has(tel)) return lidPorTelefono.get(tel);
  const mapeo = mapeoLid(sock);
  if (!mapeo) return null;
  try {
    const lid = normalizarLid(await mapeo.getLIDForPN(`${tel}@s.whatsapp.net`));
    if (lid) {
      recordarLid(lid, tel);
      return lid;
    }
  } catch (e) {
    console.warn(`No se pudo buscar el chat @lid de ${tel}:`, e.message);
  }
  return null;
}

// La versión anterior del bot (Baileys 6) guardaba esa relación por su cuenta en las claves "bf-lid" / "bf-tel".
// Al arrancar se le pasa a Baileys una vez, para que no se olviden los clientes que ya escribieron desde @lid.
// Las claves viejas no se borran: si hubiera que volver a la versión anterior, siguen ahí.
let mapeoAntiguoImportado = false;
async function importarMapeoLidAntiguo(sock, almacen) {
  if (mapeoAntiguoImportado || !almacen?.leerMapeoLidAntiguo || !mapeoLid(sock)) return;
  mapeoAntiguoImportado = true;
  try {
    const pares = await almacen.leerMapeoLidAntiguo();
    if (!pares.length) return;
    await mapeoLid(sock).storeLIDPNMappings(pares);
    console.log(`Relación @lid ↔ número de la versión anterior: ${pares.length} cliente(s) revisados en Baileys.`);
  } catch (e) {
    mapeoAntiguoImportado = false;
    console.error('No se pudo pasar la relación @lid ↔ número anterior a Baileys:', e.message);
  }
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
// meterse en la conversación durante un rato (lo elige el barbero en el panel; por defecto 30 minutos).
// Pasados 10 minutos sin que él escriba, un "hola" o un comando claro del cliente le devuelve el chat al bot.
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

// ----- Mensajes enviados, por si un celular pide que se los reenvíen -----
// Cuando un celular no logra leer un mensaje del bot (se ve "Esperando el mensaje. Esto puede tomar tiempo"),
// WhatsApp le pide al bot que lo vuelva a enviar. Sin una copia, no hay qué reenviar y el mensaje nunca aparece.
// Se guarda una copia de cada mensaje enviado durante 1 día (máximo 1000).
const mensajesEnviados = new Map(); // id -> { mensaje, cuando }
const HORAS_COPIA_ENVIADOS = 24;
const MAX_COPIAS_ENVIADOS = 1000;

export function guardarMensajeEnviado(resultado, ahoraMs = Date.now()) {
  const id = resultado?.key?.id;
  if (!id || !resultado.message) return;
  mensajesEnviados.set(id, { mensaje: resultado.message, cuando: ahoraMs });
  while (mensajesEnviados.size > MAX_COPIAS_ENVIADOS) mensajesEnviados.delete(mensajesEnviados.keys().next().value);
}

// Lo usa Baileys (getMessage) cuando un celular pide reenviar un mensaje
export function mensajeEnviadoParaReenviar(key, ahoraMs = Date.now()) {
  const copia = mensajesEnviados.get(key?.id);
  if (!copia) return undefined;
  if (ahoraMs - copia.cuando > HORAS_COPIA_ENVIADOS * 60 * 60 * 1000) {
    mensajesEnviados.delete(key.id);
    return undefined;
  }
  console.log(`[Reenvío] Un celular pidió de nuevo el mensaje ${key.id} (${key.remoteJid}): se reenvía.`);
  return copia.mensaje;
}

// Todos los envíos del bot llevan un ID propio conocido y dejan una copia para reenviarlos si hace falta
function marcarEnviosDelBot(sock) {
  const enviarOriginal = sock.sendMessage.bind(sock);
  sock.sendMessage = async (jid, contenido, opciones = {}) => {
    const resultado = await enviarOriginal(jid, contenido, { ...opciones, messageId: opciones.messageId || nuevoIdMensajeBot() });
    guardarMensajeEnviado(resultado);
    return resultado;
  };
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

// Pausa del bot en un chat donde el barbero escribió a mano:
//   'total'   -> el barbero escribió hace menos de 10 minutos: el bot no dice nada
//   'parcial' -> ya pasaron 10 minutos sin que el barbero escriba: el bot solo atiende saludos y comandos
//   null      -> pasó el tiempo elegido en el panel (30 min por defecto): el bot funciona normal
export const MINUTOS_PAUSA_TOTAL = 10;
export function estadoPausa(jids, barberia, ahoraMs = Date.now()) {
  const minutos = MINUTOS_PAUSA_VALIDOS.includes(Number(barberia?.minutosPausaBot)) ? Number(barberia.minutosPausaBot) : 30;
  const ultima = Math.max(0, ...jids.filter(Boolean).map(j => atencionHumana.get(j) || 0));
  const pasado = ahoraMs - ultima;
  if (!ultima || pasado >= minutos * 60 * 1000) return null;
  return pasado < MINUTOS_PAUSA_TOTAL * 60 * 1000 ? 'total' : 'parcial';
}
// ----- El cliente usa el menú mientras el barbero conversa en el chat -----
// Si el bot le escribió hace poco (menú, Mis citas...) y el cliente responde con una orden para el bot
// (un número, MENÚ, CANCELAR, REAGENDAR, volver), el bot le contesta aunque el barbero esté escribiendo.
// La charla normal ("jajaja", "ya voy") sigue siendo del barbero: ahí el bot no se mete.
const ultimaRespuestaBot = new Map(); // chat -> cuándo le respondió el bot por última vez
const ordenesAlBot = new Set();       // chats cuyo mensaje actual es una orden directa al bot
export const MINUTOS_MENU_ACTIVO = 10;
export function esOrdenParaBot(textoN, soloNumeros) {
  return !!soloNumeros || pideMenuExplicito(textoN) || /\bcancel/.test(textoN) || /\breagend/.test(textoN) ||
    /^(volver|inicio|opciones)$/.test(textoN);
}
function botLeEscribioHacePoco(jid, ahoraMs = Date.now()) {
  if (ultimaRespuestaBot.size > 3000) for (const [k, t] of ultimaRespuestaBot) if (ahoraMs - t > 60 * 60 * 1000) ultimaRespuestaBot.delete(k);
  return ahoraMs - (ultimaRespuestaBot.get(jid) || 0) < MINUTOS_MENU_ACTIVO * 60 * 1000;
}

// El cliente pide el MENÚ: "Menú", "MENU", "menù", "Menuuu", "el menú", "pásame el menú", "menú porfa", "meni"...
// (el texto ya viene normalizado: minúsculas, sin tildes, sin signos ni emojis). Funciona aunque el barbero esté
// hablando en el chat. No cuenta si el menú es parte de una frase ("ese menú no sirve", "el menú de hoy").
const PALABRA_MENU = '(menu+s?|meni|mneu|mebu|nemu|mrnu)';
const PEDIR_MENU = '(ver|mostrar|muestrame|muestreme|mandame|mandeme|enviame|envieme|pasame|paseme|dame|deme|quiero|quiero ver|necesito|necesito ver|me muestras|me mandas|me pasas|me envias)';
const CORTESIA_MENU = '(por favor|porfa|porfavor|plis|pliss|pls|please|pues|ps|ya|gracias)';
const RE_PIDE_MENU = new RegExp(`^(${PEDIR_MENU} )?(el |un )?${PALABRA_MENU}( ${PALABRA_MENU})*( principal)?( ${CORTESIA_MENU})*$`);
export function pideMenuExplicito(textoN) {
  return RE_PIDE_MENU.test(String(textoN || '').trim());
}

// ¿El barbero escribió a mano en este chat (por su número o por su @lid) desde ese momento?
export function barberoEscribioDesde(jid, desdeMs) {
  const relacionados = [jid];
  if (jid?.endsWith('@lid') && telefonoPorLid.get(jid)) relacionados.push(`${telefonoPorLid.get(jid)}@s.whatsapp.net`);
  if (jid?.endsWith('@s.whatsapp.net') && lidPorTelefono.get(digitosDeJid(jid))) relacionados.push(lidPorTelefono.get(digitosDeJid(jid)));
  return relacionados.some(j => (atencionHumana.get(j) || 0) >= desdeMs);
}
function botEnPausa(jids, barberia, ahoraMs = Date.now()) {
  return estadoPausa(jids, barberia, ahoraMs) !== null;
}
function liberarPausa(jids) {
  for (const j of jids.filter(Boolean)) atencionHumana.delete(j);
}

// Con la pausa parcial, ¿este mensaje le devuelve la conversación al bot?
// Un saludo corto ("hola", "buenas") o un comando claro (SI, CANCELAR, REAGENDAR, menú). Otra charla se le deja al barbero.
export function retomaConversacionBot(texto, textoN = normalizarTexto(texto)) {
  const palabras = textoN.split(' ').filter(Boolean);
  if (INTENCION.confirmar.test(textoN)) return true;
  if (/\bcancel/.test(textoN) || /\breagend/.test(textoN) || INTENCION.cancelar.test(textoN) || INTENCION.reagendar.test(textoN)) return true;
  if (pideMenuExplicito(textoN) || /^(inicio|opciones|volver)$/.test(textoN)) return true;
  return palabras.length <= 4 && INTENCION.saludo.test(textoN) && !INTENCION.gracias.test(textoN);
}
// Después de "2. No, mantener mi cita", durante estos minutos un "1" se toma como que se arrepintió
export const MINUTOS_ARREPENTIRSE = 5;
export function mensajeCambioDeOpinion(cita) {
  return `🤔 ¿Cambiaste de opinión${cita.citaNombre ? `, ${cita.citaNombre}` : ''}?\n\n` +
    `Responde *1* para *cancelar* tu cita del *${fechaLegible(cita.citaFecha)} a las ${cita.citaHora}*, ` +
    `o *2* para *mantenerla*. ✂️\n\n` +
    `_¿Querías otra cosa? Escribe *MENÚ* para ver todas las opciones._`;
}

// Menú mostrado por chat: otro saludo seguido ("Oe" "Oe") no lo repite durante 2 minutos
const ultimoMenuMostrado = new Map();
export const MINUTOS_SIN_REPETIR_MENU = 2;
function menuMostradoHacePoco(jid, ahoraMs = Date.now()) {
  const ultimo = ultimoMenuMostrado.get(jid) || 0;
  if (ultimoMenuMostrado.size > 2000) for (const [k, t] of ultimoMenuMostrado) if (ahoraMs - t > 10 * 60 * 1000) ultimoMenuMostrado.delete(k);
  return ahoraMs - ultimo < MINUTOS_SIN_REPETIR_MENU * 60 * 1000;
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
// Las dos primeras palabras del nombre: "luz andrea gómez" -> "Luz Andrea", "El Pepe" -> "El Pepe", "Carlos" -> "Carlos"
export function obtenerPrimerNombre(nombreCompleto) {
  const partes = String(nombreCompleto || '').trim().split(/\s+/).filter(Boolean);
  if (!partes.length) return 'Cliente';
  return partes.slice(0, 2).map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join(' ');
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

  const limpio = digitosDeJid(jidDirecto);
  // Siempre al chat @lid del cliente (el que ya conocemos o el que Baileys le pregunta a WhatsApp): el cliente
  // responde desde ese ID. Si el aviso se envía a su número, el cifrado queda guardado bajo el número y su
  // respuesta ("SI", "No"…) llega imposible de leer ("No matching sessions found for message").
  // Así también reconocemos al cliente cuando responde desde el chat @lid sin su número (p. ej. "SI" o "CANCELAR").
  const lid = await lidDeTelefono(sock, limpio);
  if (lid) return lid;

  try {
    // Sin chat @lid: se confirma que el número tiene WhatsApp (en Baileys 7 onWhatsApp ya no trae el @lid)
    const res = await sock.onWhatsApp(limpio);
    if (res && res.length > 0 && res[0].exists && res[0].jid) return res[0].jid;
  } catch (e) {
    console.log('Nota: fallback a JID directo:', e.message);
  }
  return jidDirecto;
}

// Función auxiliar para responder de forma natural (escribiendo... entre 2.5s y 4s según longitud)
// Clientes que acaban de iniciar conversación: a su primera respuesta se le antepone un saludo
const saludoPendiente = new Set();

// Máximo 15 mensajes del bot a un mismo chat cada 10 minutos (si otro bot le responde, no se arma un bucle).
// Una persona usando el menú no llega a eso; un bucle entre bots sí, en menos de un minuto.
const enviosPorChat = new Map(); // jid -> [instantes]
export const MAX_ENVIOS_POR_CHAT = 15;
function cupoDeEnvio(jid) {
  const ahora = Date.now();
  const recientes = (enviosPorChat.get(jid) || []).filter(t => ahora - t < 10 * 60 * 1000);
  if (recientes.length >= MAX_ENVIOS_POR_CHAT) {
    enviosPorChat.set(jid, recientes);
    if (recientes.length === MAX_ENVIOS_POR_CHAT) console.warn(`[Tope] Demasiados mensajes seguidos a ${digitosDeJid(jid)}: el bot se calla 10 minutos en ese chat.`);
    return false;
  }
  recientes.push(ahora);
  enviosPorChat.set(jid, recientes);
  if (enviosPorChat.size > 2000) for (const [k, v] of enviosPorChat) if (!v.some(t => ahora - t < 10 * 60 * 1000)) enviosPorChat.delete(k);
  return true;
}

const enviarMensajeHumano = async (sock, remitente, textoRespuesta) => {
  try {
    if (!sock || (!estaConectado && !MODO_PRUEBA && !sock.esPrueba)) return false;
    if (!MODO_PRUEBA && !sock.esPrueba && !cupoDeEnvio(remitente)) return false;

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

    const inicio = Date.now();
    await sock.sendPresenceUpdate('composing', remitente);
    await new Promise(r => setTimeout(r, tiempoTotal));
    // Mientras el bot "escribía", ¿el barbero respondió a mano en ese chat? Entonces el bot no se mete,
    // salvo que el cliente le haya dado una orden directa al bot (un número del menú, MENÚ, CANCELAR...)
    if (!ordenesAlBot.has(remitente) && barberoEscribioDesde(remitente, inicio)) {
      await sock.sendPresenceUpdate('paused', remitente).catch(() => {});
      console.log(`[Atención humana] El barbero respondió en ${remitente} mientras el bot escribía: el bot no envía su mensaje.`);
      return false;
    }
    await sock.sendMessage(remitente, { text: textoRespuesta });
    ultimaRespuestaBot.set(remitente, Date.now());
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
      const res = await fetch(`${API_BASE_URL}/barberia/${BARBERIA_SLUG}`, { signal: AbortSignal.timeout(10000) });
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
    '/api/enviar-codigo': manejarEnviarCodigo,
    '/api/notificar-lista-espera': manejarNotificarListaEspera,
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
  process.on('unhandledRejection', err => console.error('[Error sin manejar]', err?.message || err));
}
if (process.env.BOT_HIJO === '1') {
  // Si el gestor se cae, esta copia se apaga: el gestor nuevo enciende otra y nunca quedan dos con el mismo WhatsApp
  process.on('disconnect', () => process.exit(0));
  servidorHttp.on('error', err => { console.error('[Servidor del bot]', err.message); process.exit(1); });
}
if (!MODO_PRUEBA && !MODO_GESTOR) {
  // Las copias por barbería solo las usa el gestor: escuchan únicamente por dentro (127.0.0.1)
  servidorHttp.listen(PORT, process.env.BOT_HIJO === '1' ? '127.0.0.1' : '0.0.0.0', () => {
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
  // Ver sus citas ("mis citas", "tengo cita?", "a qué hora es mi cita")
  misCitas: /\b(mis citas|mi cita|mis turnos|mi turno|mis reservas|mi reserva|tengo (una )?cita|cuando es mi cita|a que hora es mi cita|ver (mi|mis) citas?)\b/,
  // Un "no" suelto: no confirma ni cancela nada
  negacion: /^(no+|nop|nope|nel|negativo|no se|nose|ns)$/,
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

// El cliente respondió algo que no es una opción ("No", "hola", "amén"…) y tiene una cita por confirmar
export function mensajeRespuestaNoValida(cita) {
  const nombre = obtenerPrimerNombre(cita.nombreCliente);
  return `🤔 ${nombre}, esa respuesta no es una de las opciones.\n\n` +
    `Sobre tu cita de *${cita.servicio}* el *${fechaLegible(cita.fecha)} a las ${cita.hora}*, responde:\n\n` +
    `• *SI* para confirmar que vienes ✅\n` +
    `• *CANCELAR* si no puedes asistir ❌\n` +
    `• *REAGENDAR* para cambiar el día o la hora 🔄\n\n` +
    `_¿Necesitas otra cosa? Escribe *MENÚ* para ver todas las opciones._`;
}

// ----- Pregunta pendiente: el bot le pidió al cliente responder SI / CANCELAR sobre una cita -----
// Mientras no responda una opción válida, cualquier otra cosa ("hola", "no", "amén") recibe las opciones de nuevo.
// Se guarda también en el almacén de la sesión para que sobreviva a un reinicio del bot.
const preguntaCita = new Map(); // jid -> { citaId, nombreCliente, servicio, fecha, hora } | null
export function guardarPreguntaCita(jid, datos) {
  if (!jid || !datos?.citaId) return;
  preguntaCita.set(jid, datos);
  almacenClavesSesion?.set({ 'bf-pregunta': { [jid]: datos } }).catch(e => console.error('No se pudo guardar la pregunta pendiente:', e.message));
}
export function borrarPreguntaCita(jids) {
  for (const j of jids.filter(Boolean)) {
    if (preguntaCita.get(j) === null) continue;
    preguntaCita.set(j, null);
    almacenClavesSesion?.set({ 'bf-pregunta': { [j]: null } }).catch(() => {});
  }
}
export async function preguntaCitaDe(jids, ahoraMs = Date.now()) {
  for (const j of jids.filter(Boolean)) {
    let p = preguntaCita.get(j);
    if (p === undefined) {
      try { p = (await almacenClavesSesion?.get('bf-pregunta', [j]))?.[j] || null; } catch (e) { p = null; }
      if (preguntaCita.size > 5000) preguntaCita.clear();
      preguntaCita.set(j, p);
    }
    if (!p) continue;
    const inicio = instanteCita(p.fecha, p.hora);
    if (inicio && ahoraMs > inicio) { borrarPreguntaCita([j]); continue; } // la cita ya pasó
    return p;
  }
  return null;
}

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

// La plantilla del barbero a veces no ofrece REAGENDAR (o tampoco CANCELAR): se agrega con el mismo estilo,
// justo debajo de la línea de CANCELAR, o antes de la última línea divisoria (━━━) si no la hay.
export function asegurarOpcionReagendar(texto) {
  if (/REAGEND/i.test(texto)) return texto;
  const lineas = String(texto).split('\n');
  const iCancelar = lineas.findIndex(l => /CANCELAR/i.test(l));
  if (iCancelar >= 0) {
    const prefijo = (lineas[iCancelar].match(/^(.*?)Responde/i) || [null, '• '])[1];
    lineas.splice(iCancelar + 1, 0, `${prefijo}Responde *REAGENDAR* si quieres cambiar el día o la hora 🔄`);
    return lineas.join('\n');
  }
  const linea = `👉 Si no puedes asistir, responde *CANCELAR* o *REAGENDAR*.`;
  let iDivisoria = -1;
  lineas.forEach((l, i) => { if (/^\s*[━─—=_-]{5,}\s*$/.test(l)) iDivisoria = i; });
  if (iDivisoria > 0) {
    lineas.splice(iDivisoria, 0, linea);
    return lineas.join('\n');
  }
  return `${texto}\n\n${linea}`;
}

// "Mis citas": las próximas citas del cliente y qué puede hacer con ellas
export function mensajeMisCitas(citas) {
  const una = citas.length === 1;
  const nombre = obtenerPrimerNombre(citas[0]?.nombreCliente);
  let texto = `🗓️ *${una ? 'Tu próxima cita' : 'Tus próximas citas'}, ${nombre}*\n\n`;
  citas.forEach((c, i) => {
    texto += `${una ? '' : `*${i + 1}.* `}${iconoCategoria(c.servicio)} *${c.servicio}*\n` +
      `📅 ${fechaLegible(c.fecha)}\n` +
      `⏰ ${c.hora}\n` +
      (c.barbero ? `💈 Con ${c.barbero}\n` : '') +
      `🔖 ${c.codigoReserva} · ${c.estado === 'Pendiente' ? '⏳ Por confirmar' : '✅ Confirmada'}\n\n`;
  });
  return texto +
    `¿Qué quieres hacer?\n\n` +
    `*1* 🔄 Reagendar ${una ? '(cambiar día u hora)' : 'una cita'}\n` +
    `*2* ❌ Cancelar ${una ? 'la cita' : 'una cita'}\n` +
    `*0* 🏠 Volver al menú\n\n` +
    `📖 _Tu historial de citas está en tu cuenta:_\n👉 ${linkCuenta()}`;
}

function linkCuenta() { return `${BASE_WEB_URL}/cuenta.html?b=${encodeURIComponent(BARBERIA_SLUG)}`; }

// Con varias citas: ¿cuál quiere reagendar o cancelar?
export function mensajeElegirCita(citas, accion) {
  return `${accion === 'reagendar' ? '🔄' : '❌'} ¿Cuál cita quieres *${accion}*? Escribe su número:\n\n` +
    citas.map((c, i) => `*${i + 1}.* ${iconoCategoria(c.servicio)} ${c.servicio} — ${fechaLegible(c.fecha)} · ${c.hora}`).join('\n') +
    `\n\n*0* 🏠 Volver al menú`;
}

function linkReservas() { return `${BASE_WEB_URL}/${encodeURIComponent(BARBERIA_SLUG)}`; }

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
    `*4* 🗓️ Mis citas (ver, cambiar o cancelar)\n` +
    `*5* 💳 Formas de pago\n\n` +
    `_Por ejemplo, escribe *1* para reservar._\n` +
    `_Escribe *MENÚ* cuando quieras volver a ver estas opciones._`;
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
    msgPersonalizado = asegurarOpcionReagendar(msgPersonalizado);
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
  // Se le pidió responder SI: hasta que responda una opción válida, el bot le recuerda las opciones
  if (enviado && !creadaPorBarbero && mencionaConfirmar(msgConfirmacion)) {
    guardarPreguntaCita(jid, { citaId, nombreCliente, servicio, fecha, hora });
  }
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
    ? `${linkReservas()}?reagendar=${encodeURIComponent(tokenPublico)}`
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

// Código para cambiar la contraseña (barbero) o la clave (cliente). El código nunca se escribe en los registros.
export function mensajeCodigo({ nombre, codigo, para }, barberiaNombre) {
  const aviso = `\n\nVence en 10 minutos. Si no lo pediste tú, ignora este mensaje: sin el código nadie puede cambiar la clave.`;
  if (para === 'barbero') {
    return `🔐 *Código para cambiar la contraseña de tu panel de BarberFlow*\n\nTu código es: *${codigo}*` + aviso;
  }
  return `🔐 ¡Hola ${obtenerPrimerNombre(nombre)}! Tu código para cambiar la clave de tu cuenta en *${barberiaNombre || 'la barbería'}* es: *${codigo}*` + aviso;
}

export async function manejarEnviarCodigo(payload) {
  const { barberiaSlug, barberiaNombre, telefono, codigo } = payload || {};
  if (barberiaSlug && barberiaSlug.toLowerCase() !== BARBERIA_SLUG.toLowerCase()) {
    return { enviado: false, razon: 'Código de otra barbería' };
  }
  if (!telefono || !/^\d{6}$/.test(String(codigo || ''))) return { enviado: false, razon: 'Datos incompletos' };
  if (!socketActivo || (!estaConectado && !MODO_PRUEBA)) return { enviado: false, razon: 'Bot no conectado' };
  const jid = await resolverJidDestinatario(socketActivo, telefono);
  const enviado = await enviarMensajeHumano(socketActivo, jid, mensajeCodigo(payload, barberiaNombre));
  console.log(`[Código de recuperación] ${enviado ? 'Enviado' : 'No se pudo enviar'} (${payload.para || 'cliente'}).`);
  return { enviado };
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

// Lista de espera: se liberó un turno el día que el cliente quería; el primero que reserva se lo queda
export function mensajeListaEspera({ nombreCliente, servicioId, fecha, hora }, barberiaNombre, ahoraMs = Date.now()) {
  const hoy = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date(ahoraMs));
  const dia = fecha === hoy ? 'hoy' : `el *${fechaLegible(fecha)}*`;
  const min = hora ? horaAMinutos(hora) : null;
  const cuando = min !== null && min !== undefined ? `${dia} a las *${minutosATextoBot(min)}*` : dia;
  const enlace = `${linkReservas()}?fecha=${encodeURIComponent(fecha)}` +
    (servicioId ? `&servicio=${encodeURIComponent(servicioId)}` : '');
  const nombre = obtenerPrimerNombre(nombreCliente);
  return `🔔 ¡Hola${nombre ? ` ${nombre}` : ''}! Se liberó un turno en *${barberiaNombre || 'la barbería'}* ${cuando}.\n\n` +
    `Como estás en la lista de espera, te avisamos primero. Si lo quieres, resérvalo aquí antes de que alguien más lo tome:\n` +
    `👉 ${enlace}`;
}

export async function manejarNotificarListaEspera(payload) {
  const { barberiaSlug, barberiaNombre, telefonoCliente } = payload || {};
  if (barberiaSlug && barberiaSlug.toLowerCase() !== BARBERIA_SLUG.toLowerCase()) {
    return { enviado: false, razon: 'Aviso de otra barbería' };
  }
  if (!telefonoCliente || !socketActivo || (!estaConectado && !MODO_PRUEBA)) return { enviado: false, razon: 'Bot no conectado o sin teléfono' };
  const jid = await resolverJidDestinatario(socketActivo, telefonoCliente);
  const texto = mensajeListaEspera(payload, barberiaNombre);
  const enviado = !!(await enviarMensajeHumano(socketActivo, jid, texto));
  console.log(`[Lista de espera] ${enviado ? 'Avisado' : 'No se pudo avisar a'} ${obtenerPrimerNombre(payload.nombreCliente)}.`);
  return { enviado, texto: MODO_PRUEBA ? texto : undefined };
}

// Solicitud de reseña: 1 hora después de que TERMINE la cita (no después de reservar).
// Devuelve en cuántos minutos se enviará, o null si no se programó.
// Nota: se guarda en memoria; si el servicio se reinicia antes, esa reseña no se envía.
const MAX_ESPERA_MS = 20 * 24 * 60 * 60 * 1000; // setTimeout no admite esperas mayores a ~24 días
// El enlace usa el token público de la cita (no el Id secuencial, que permitiría ver/calificar citas ajenas).
export function urlCalificarCita(tokenPublico) {
  return `${linkReservas()}?calificar=${encodeURIComponent(tokenPublico)}`;
}

const encuestasProgramadas = new Map(); // citaId -> temporizador
function agendarEncuestaPostCita(jid, primerNombre, citaId, tokenPublico, barberiaNombre, fecha, hora, duracionMinutos) {
  const inicio = instanteCita(fecha, hora);
  if (!inicio || !citaId || !tokenPublico) return null;
  const envio = inicio + ((Number(duracionMinutos) || 40) + 60) * 60 * 1000;
  const espera = envio - Date.now();
  if (espera < 0 || espera > MAX_ESPERA_MS) return null;

  clearTimeout(encuestasProgramadas.get(citaId));
  encuestasProgramadas.set(citaId, setTimeout(async () => {
    encuestasProgramadas.delete(citaId);
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
  }, espera));
  return Math.round(espera / 60000);
}

// Recordatorios automáticos: el barbero elige en el panel uno o varios momentos (2 días, 1 día, 12, 6, 3, 2 o 1 hora antes).
// Se apagan desde el panel o con RECORDATORIOS_ACTIVOS=0. Se recuerda en memoria qué recordatorio de cada cita ya salió.
const HORAS_RECORDATORIO_VALIDAS = [48, 24, 12, 6, 3, 2, 1];

// Marcas guardadas junto a la sesión de WhatsApp (PostgreSQL): así un reinicio no repite recordatorios ni el anuncio
async function marcaGuardada(tipo, id) {
  try { return !!(await almacenClavesSesion?.get(tipo, [id]))?.[id]; } catch (e) { return false; }
}
function guardarMarca(tipo, id) {
  almacenClavesSesion?.set({ [tipo]: { [id]: Date.now() } }).catch(e => console.error('No se pudo guardar la marca:', e.message));
}
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
      if (await marcaGuardada('bf-rec', `${c.id}:${horas}`)) { recordatoriosEnviados.add(`${c.id}:${horas}`); continue; }
      // Si acaba de reservar (le llegó la confirmación hace menos de 1 h y media), no recordarle todavía
      const desdeConfirmacion = ahoraMs - (confirmacionEnviada.get(c.id) ?? -Infinity);
      if (desdeConfirmacion >= 0 && desdeConfirmacion < 90 * 60 * 1000) continue;

      recordatoriosEnviados.add(`${c.id}:${horas}`);
      guardarMarca('bf-rec', `${c.id}:${horas}`);
      const jid = await resolverJidDestinatario(socketActivo, c.telefonoCliente);
      const plantillaRec = (barberiaDatos.plantillaRecordatorio || '').trim();
      if (plantillaRec) {
        let texto = aplicarPlantilla(plantillaRec, {
          cliente: obtenerPrimerNombre(c.nombreCliente), servicio: c.servicio, fecha: fechaLegible(fechaIso), hora: c.hora,
          codigo: c.codigoReserva || '', barberia: data.nombre || '', direccion: barberiaDatos.direccion || '', barbero: c.barbero || ''
        });
        if (c.estado === 'Pendiente' && !mencionaConfirmar(texto)) texto += `\n\n👉 Responde *SI* para confirmar que vienes.`;
        texto = asegurarOpcionReagendar(texto);
        if (await enviarMensajeHumano(socketActivo, jid, texto) && c.estado === 'Pendiente') {
          guardarPreguntaCita(jid, { citaId: c.id, nombreCliente: c.nombreCliente, servicio: c.servicio, fecha: fechaIso, hora: c.hora });
        }
        enviados.push(c.id);
        continue;
      }
      const recordatorioEnviado = await enviarMensajeHumano(
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
      if (recordatorioEnviado && c.estado === 'Pendiente') {
        guardarPreguntaCita(jid, { citaId: c.id, nombreCliente: c.nombreCliente, servicio: c.servicio, fecha: fechaIso, hora: c.hora });
      }
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
    ultimoMenuMostrado.delete(JID_CHAT_PRUEBA);
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
  // Sin base de datos (local), cada barbería guarda su sesión en su propia carpeta
  const carpeta = process.env.BOT_HIJO === '1' ? `./auth_info_baileys/${BARBERIA_SLUG}` : undefined;
  almacenSesion ||= crearAlmacenSesion({ databaseUrl: process.env.DATABASE_URL, sesion: BARBERIA_SLUG, carpeta })
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
const HISTORIAL_PERMITIDO = new Set([
  proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP,
  proto.HistorySync.HistorySyncType.PUSH_NAME,
  proto.HistorySync.HistorySyncType.NON_BLOCKING_DATA
]);
let reconexionesSeguidas = 0;
const loggerBaileys = DEFAULT_CONNECTION_CONFIG.logger.child({});
loggerBaileys.level = process.env.BOT_LOG_NIVEL || 'warn';
function reintentarBot(generacion, ms) {
  setTimeout(() => { if (generacion === generacionBot) iniciarBot(); }, ms);
}

async function resetearSesionWhatsApp() {
  generacionBot++;
  const anterior = socketActivo;
  const estabaConectado = estaConectado;
  socketActivo = null;
  if (estabaConectado) {
    try { await Promise.race([anterior?.logout(), new Promise(r => setTimeout(r, 5000))]); } catch (e) { /* ya estaba cerrada */ }
  }
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
  const sock = marcarEnviosDelBot(makeWASocket({
    auth: state,
    markOnlineOnConnect: false,          // si el bot aparece "en línea", al barbero dejan de sonarle las notificaciones
    // Del historial solo lo liviano que llega al vincular con el QR: ahí WhatsApp manda la relación @lid ↔ número
    // de los contactos. El historial reciente y el completo (chats y mensajes viejos) no se descargan: menos memoria.
    shouldSyncHistoryMessage: ({ syncType }) => HISTORIAL_PERMITIDO.has(syncType),
    // Si un celular no pudo leer un mensaje del bot y pide que se lo reenvíen, se le manda la copia guardada
    getMessage: async (key) => mensajeEnviadoParaReenviar(key),
    logger: loggerBaileys
  }));
  socketActivo = sock;
  obtenerAlmacenSesion().then(almacen => importarMapeoLidAntiguo(sock, almacen)).catch(() => {});
  // Cuando Baileys aprende qué número tiene un chat @lid, se copia a la memoria rápida del bot
  sock.ev.on('lid-mapping.update', (par) => {
    for (const { lid, pn } of [].concat(par || [])) {
      if (String(pn || '').endsWith('@s.whatsapp.net')) recordarLid(lid, digitosDeJid(pn));
    }
  });

  sock.ev.on('creds.update', () => Promise.resolve(saveCreds()).catch(e => console.error('No se pudo guardar la sesión de WhatsApp:', e.message)));

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
        reconexionesSeguidas++;
        const espera = statusCode === DisconnectReason.connectionReplaced
          ? 60000
          : Math.min(60000, 3000 * 2 ** Math.min(reconexionesSeguidas - 1, 5));
        reintentarBot(generacion, espera);
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
      reconexionesSeguidas = 0;
      estaConectado = true;
      ultimoQrDataUrl = '';
      estadoConexion = 'Conectado';
      console.log('¡WhatsApp en línea y conectado!');
    }
  });

  sock.ev.on('messages.upsert', (m) => procesarMensajeEntrante(sock, m));

  // Diagnóstico: cuando un celular (el del barbero o el de un cliente) no pudo leer un mensaje del bot,
  // pide que se lo reenvíen. Se deja en los registros para saber si el reenvío está funcionando.
  sock.ws.on('CB:receipt', (node) => {
    try {
      if (node?.attrs?.type !== 'retry') return;
      const { id, from, recipient } = node.attrs;
      const copia = mensajesEnviados.has(id) ? 'el bot tiene la copia y lo reenvía' : 'el bot ya no tiene la copia';
      console.log(`[Reintento] ${from} no pudo leer el mensaje ${id}${recipient ? ` (chat ${recipient})` : ''}: ${copia}.`);
    } catch (e) {}
  });
}

// ----- Mensaje que WhatsApp entregó pero no se pudo descifrar -----
// Pasa cuando el cifrado con ese cliente quedó guardado bajo su número y él escribe desde su ID @lid
// ("No matching sessions found for message"). Al escribirle al chat @lid se crea un cifrado nuevo,
// así que se le pide que lo reenvíe y desde ahí el bot sí lo lee. Máximo una vez cada 30 min por chat.
const avisosIlegible = new Map();
const CIFRADO_PERDIDO = /no matching sessions|no session/i;
export function debeAvisarIlegible(msg, ahoraMs = Date.now()) {
  const jid = msg?.key?.remoteJid || '';
  if (msg?.message || msg?.key?.fromMe || msg?.messageStubType !== 2) return false; // 2 = CIPHERTEXT
  if (!jid.endsWith('@lid') && !jid.endsWith('@s.whatsapp.net')) return false;
  if (!CIFRADO_PERDIDO.test(String(msg.messageStubParameters?.[0] || ''))) return false;
  const enviadoMs = marcaDeTiempoMs(msg);
  if (enviadoMs > 0 && ahoraMs - enviadoMs > 10 * 60 * 1000) return false;
  if (ahoraMs - (avisosIlegible.get(jid) || 0) < 30 * 60 * 1000) return false;
  avisosIlegible.set(jid, ahoraMs);
  return true;
}

async function avisarMensajeIlegible(sock, msg) {
  try {
    if (!debeAvisarIlegible(msg)) return;
    const jid = msg.key.remoteJid;
    console.warn(`[Cifrado] No se pudo leer un mensaje de ${jid}: se le pide reenviarlo.`);
    const desde = Date.now();
    // WhatsApp reintenta solo: si en unos segundos el mensaje sí se pudo leer, no hace falta escribirle
    await new Promise(r => setTimeout(r, MODO_PRUEBA ? 0 : 8000));
    if ((ultimaInteraccionCliente.get(jid) || 0) >= desde) return;
    const barberia = await obtenerDatosBarberia();
    if (barberia.botActivo === false) return;
    const tel = await telefonoDelRemitenteAsync(sock, msg.key);
    if (botEnPausa([jid, tel && `${tel}@s.whatsapp.net`], barberia)) return;
    await enviarMensajeHumano(sock, jid,
      `😅 Perdona, no alcanzamos a leer tu último mensaje. ¿Nos lo puedes enviar de nuevo, por favor?`);
  } catch (e) {
    console.error('Error avisando mensaje ilegible:', e.message);
  }
}

// ----------------- LÓGICA DE CONVERSACIÓN -----------------
export async function procesarMensajeEntrante(sock, m) {
    try {
      if (!m.messages || m.messages.length === 0) return;
      // Al reconectar pueden llegar varios mensajes juntos: se atiende cada uno
      if (m.messages.length > 1) {
        for (const uno of m.messages) await procesarMensajeEntrante(sock, { ...m, messages: [uno] });
        return;
      }
      const msg = m.messages[0];
      if (!msg.message) {
        if (m.type === 'notify' || m.type === undefined) avisarMensajeIlegible(sock, msg);
        return;
      }

      // ¿Lo escribió el barbero desde su celular? Entonces el bot se calla un rato en ese chat
      if (msg.key?.fromMe) {
        registrarRespuestaDelBarbero(msg);
        return;
      }

      // Solo mensajes nuevos: al reconectar llegan mensajes de historial (type 'append') que no se deben contestar
      if (m.type && m.type !== 'notify') return;
      // Mensajes de hace más de 10 minutos (llegaron mientras el bot estaba desconectado): no se contestan
      const enviadoMs = marcaDeTiempoMs(msg);
      if (!MODO_PRUEBA && enviadoMs > 0 && Date.now() - enviadoMs > 10 * 60 * 1000) return;

      const remitente = msg.key.remoteJid;
      // 🛡️ REGLA 1: Ignorar grupos y difusiones
      if (!remitente || remitente.includes('@g.us') || remitente.includes('broadcast') || remitente.includes('@newsletter')) return;

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
      // Respuesta de otro bot de BarberFlow (trae nuestros enlaces o menús): no contestar para no armar un bucle
      if (texto.includes('index.html?b=') || texto.includes(HOST_WEB) || texto.includes('escribe solo el número')) return;
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
      const telSoloDigitos = await telefonoDelRemitenteAsync(sock, msg.key);
      const ultimos10 = telSoloDigitos.length >= 10 ? telSoloDigitos.slice(-10) : telSoloDigitos;
      const telBusqueda = telSoloDigitos;

      console.log(`[Mensaje Recibido] De: ${remitente} | Tel: ${telSoloDigitos || '(desconocido)'} | Texto: ${texto}`);
      if (!telSoloDigitos) {
        console.warn(`[Aviso] No se pudo obtener el número real de ${remitente} (el mensaje no trae su número).`);
      }

      // El barbero está hablando personalmente con este cliente: no interrumpir
      const jidsDelChat = [remitente, telSoloDigitos && `${telSoloDigitos}@s.whatsapp.net`, telSoloDigitos && lidPorTelefono.get(telSoloDigitos)];
      const pausa = sock.esPrueba ? null : estadoPausa(jidsDelChat, barberia);
      // ¿Es una orden directa para el bot? (MENÚ, o un número/CANCELAR/REAGENDAR justo después de que el bot le escribió)
      const ordenAlBot = pideMenuExplicito(textoN) ||
        (esOrdenParaBot(textoN, soloNumeros) && jidsDelChat.some(j => j && botLeEscribioHacePoco(j, ahora)));
      if (ordenAlBot) ordenesAlBot.add(remitente);
      if (pausa && ordenAlBot) {
        // El barbero está conversando, pero el cliente está usando el menú: el bot le responde la opción.
        // La pausa sigue: si el cliente vuelve a charlar, eso queda para el barbero.
        console.log(`[Atención humana] ${remitente} usó el menú ("${texto}") mientras el barbero conversa: el bot responde esa opción.`);
      } else if (pausa === 'total' || (pausa === 'parcial' && !retomaConversacionBot(texto, textoN))) {
        saludoPendiente.delete(remitente);
        console.log(`[Atención humana] ${remitente} escribió, pero el barbero está atendiendo ese chat: el bot no responde.`);
        return;
      }
      if (pausa === 'parcial') {
        // El barbero lleva más de 10 minutos sin escribir y el cliente saludó o pidió algo claro: el bot retoma el chat
        liberarPausa(jidsDelChat);
        console.log(`[Atención humana] ${remitente} escribió "${texto}" y el barbero no escribe hace más de ${MINUTOS_PAUSA_TOTAL} min: el bot retoma la conversación.`);
      }

      let estado = estadoCliente.get(remitente) || { nivel: 'INICIO' };

      // Saludo de bienvenida con el menú (personalizado si ya es cliente)
      const saludarConMenu = async (notaFinal = '') => {
        ultimoMenuMostrado.set(remitente, Date.now());
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

      // ¿Tiene pendiente responder SI / CANCELAR sobre su cita? Solo valen esas opciones (y MENÚ para salir);
      // cualquier otra cosa ("hola", "no", "amén") no cambia nada: se le recuerdan las opciones.
      if (estado.nivel !== 'CONFIRMAR_CANCELACION') {
        let pregunta = await preguntaCitaDe(jidsDelChat);
        // Si la cita ya se canceló (desde la página o el panel), la pregunta ya no aplica
        if (pregunta && !(await citaSigueActiva(pregunta.citaId))) {
          borrarPreguntaCita(jidsDelChat);
          pregunta = null;
        }
        if (pregunta) {
          const esSi = INTENCION.confirmar.test(textoN);
          const esCancelar = textoN.includes('cancel') || INTENCION.cancelar.test(textoN);
          const esReagendar = textoN.includes('reagend') || INTENCION.reagendar.test(textoN);
          const esMenu = pideMenuExplicito(textoN) || /^(inicio|opciones|volver|0)$/.test(textoN);
          if (esMenu) {
            borrarPreguntaCita(jidsDelChat);
            await saludarConMenu();
            return;
          }
          if (!esSi && !esCancelar && !esReagendar) {
            console.log(`[Pregunta pendiente] ${remitente} escribió "${texto}": se le recuerdan las opciones de su cita.`);
            await enviarMensajeHumano(sock, remitente, mensajeRespuestaNoValida(pregunta));
            return;
          }
          borrarPreguntaCita(jidsDelChat); // respondió una opción válida: sigue el flujo normal
        }
      }

      // Si la conversación empieza con solo un número ("4"), primero se saluda y se muestran las opciones
      if (esInicioConversacion && soloNumeros) {
        await saludarConMenu();
        return;
      }

      // ¿Acaba de elegir "2. Mantener mi cita" y se arrepintió ("1")? Se le vuelve a preguntar antes de cancelar
      if (estado.nivel === 'CITA_MANTENIDA') {
        const reciente = ahora - (estado.desde || 0) < MINUTOS_ARREPENTIRSE * 60 * 1000;
        if (reciente && soloNumeros === '1') {
          estadoCliente.set(remitente, { ...estado, nivel: 'CONFIRMAR_CANCELACION', desde: ahora });
          console.log(`[Cancelar] ${remitente} eligió mantener su cita y luego escribió "1": se le vuelve a preguntar.`);
          await enviarMensajeHumano(sock, remitente, mensajeCambioDeOpinion(estado));
          return;
        }
        estadoCliente.set(remitente, { nivel: 'INICIO' });
        estado = { nivel: 'INICIO' };
      }

      // ----------------- FLUJO DE CANCELACIÓN CON CONFIRMACIÓN SEGURA -----------------
      if (estado.nivel === 'CONFIRMAR_CANCELACION') {
        const palabras = texto.split(/[^a-z0-9áéíóúñü]+/).filter(Boolean);
        const vencido = ahora - (estado.desde || 0) > 10 * 60 * 1000;
        const quiereMenu = soloNumeros === '0' || pideMenuExplicito(textoN) || ['inicio', 'volver'].includes(textoN);

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
              if (!resCanc.ok) {
                const datosError = await resCanc.json().catch(() => ({}));
                // Pasó el límite mientras confirmaba: se le explica en vez del error genérico
                if (datosError.fueraDeLimite) {
                  await enviarMensajeHumano(sock, remitente, `⏰ ${datosError.message}\n\nEl barbero te responderá por este chat en cuanto pueda. 🙏`);
                  return;
                }
                console.error(`[Cancelar] La API respondió ${resCanc.status} para la cita ${estado.citaId}`);
              }
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
              `👉 ${linkReservas()}`;

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
            // Por unos minutos se recuerda la cita: si se arrepiente y escribe "1", se le vuelve a preguntar
            estadoCliente.set(remitente, { ...estado, nivel: 'CITA_MANTENIDA', desde: ahora });
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

      // Cancelar una cita: primero se pide confirmar (1 = sí, 2 = no)
      const pedirConfirmarCancelacion = async (cita) => {
        const primerNombre = obtenerPrimerNombre(cita.nombreCliente);
        // Muy cerca de la hora: la barbería no deja cancelar por aquí; el barbero responde personalmente
        if (cita.motivoNoModificable) {
          await enviarMensajeHumano(sock, remitente,
            `⏰ ${primerNombre}, tu cita es a las *${cita.hora}*. ${cita.motivoNoModificable.replace(/ Escríbele al barbero por WhatsApp\.$/, '')}\n\nEl barbero te responderá por este chat en cuanto pueda. 🙏`);
          return;
        }
        estadoCliente.set(remitente, {
          nivel: 'CONFIRMAR_CANCELACION',
          desde: Date.now(),
          citaId: cita.id,
          citaFecha: cita.fecha,
          citaHora: cita.hora,
          citaNombre: primerNombre
        });
        await enviarMensajeHumano(sock, remitente,
          `Hola ${primerNombre}, encontramos tu cita:\n\n` +
          `${iconoCategoria(cita.servicio)} *${cita.servicio}*\n` +
          `📅 ${fechaLegible(cita.fecha)}\n` +
          `⏰ ${cita.hora}\n` +
          `🔖 ${cita.codigoReserva}\n\n` +
          `¿Seguro que quieres cancelarla?\n\n` +
          `*1.* Sí, cancelar ❌\n` +
          `*2.* No, mantener mi cita ✅`);
      };

      // Reagendar una cita: enlace para elegir el nuevo día y hora
      const enviarEnlaceReagendar = async (cita) => {
        if (cita.motivoNoModificable) {
          await enviarMensajeHumano(sock, remitente,
            `⏰ ${cita.motivoNoModificable.replace(/ Escríbele al barbero por WhatsApp\.$/, '')}\n\nEl barbero te responderá por este chat en cuanto pueda. 🙏`);
          return;
        }
        const url = `${linkReservas()}?reagendar=${encodeURIComponent(cita.tokenPublico)}`;
        await enviarMensajeHumano(sock, remitente,
          `🔄 *Cambiar tu cita*\n\n` +
          `Para elegir un nuevo día y hora de tu cita (*${cita.servicio}*, ${fechaLegible(cita.fecha)} a las ${cita.hora}), entra aquí:\n` +
          `👉 ${url}\n\n` +
          `_Cuando elijas el nuevo horario, tu cita anterior se libera sola._`);
      };

      // "Mis citas": lista de próximas citas del cliente (null = no se pudo consultar)
      const buscarMisCitasAsync = async () => {
        if (!telSoloDigitos) return null;
        try {
          const res = await apiBotFetch(`/bot/${BARBERIA_SLUG}/mis-citas/${telSoloDigitos}`);
          if (res.ok) return await res.json();
        } catch (e) {
          console.error('[Mis citas]', e.message);
        }
        return null;
      };

      // Dentro de "Mis citas": 1 = reagendar, 2 = cancelar, 0 = menú (y luego, con varias citas, cuál)
      if ((estado.nivel === 'MIS_CITAS' || estado.nivel === 'MIS_CITAS_CUAL') && ahora - (estado.desde || 0) < 30 * 60 * 1000) {
        const citas = estado.citas || [];
        if (soloNumeros === '0' || pideMenuExplicito(textoN) || /^(inicio|volver|opciones)$/.test(textoN)) {
          estadoCliente.set(remitente, { nivel: 'INICIO' });
          await enviarMensajeHumano(sock, remitente, menuPrincipal(barberia, `💈 *${barberia.nombre || 'Bienvenido'}*`));
          return;
        }
        if (estado.nivel === 'MIS_CITAS') {
          const accion = (soloNumeros === '1' || /reagend|cambiar|mover/.test(textoN)) ? 'reagendar'
            : (soloNumeros === '2' || /cancel/.test(textoN)) ? 'cancelar' : null;
          if (!accion) {
            await enviarMensajeHumano(sock, remitente,
              `🤔 Esa opción no es válida. Responde:\n\n*1* 🔄 para reagendar\n*2* ❌ para cancelar\n*0* 🏠 para volver al menú`);
            return;
          }
          if (citas.length === 1) {
            estadoCliente.set(remitente, { nivel: 'INICIO' });
            await (accion === 'reagendar' ? enviarEnlaceReagendar : pedirConfirmarCancelacion)(citas[0]);
            return;
          }
          estadoCliente.set(remitente, { nivel: 'MIS_CITAS_CUAL', accion, citas, desde: ahora });
          await enviarMensajeHumano(sock, remitente, mensajeElegirCita(citas, accion));
          return;
        }
        const indice = parseInt(soloNumeros, 10) - 1;
        if (isNaN(indice) || indice < 0 || indice >= citas.length) {
          await enviarMensajeHumano(sock, remitente,
            `🤔 Esa opción no es válida. Escribe el número de la cita (del *1* al *${citas.length}*), o *0* para volver al menú.`);
          return;
        }
        estadoCliente.set(remitente, { nivel: 'INICIO' });
        await (estado.accion === 'reagendar' ? enviarEnlaceReagendar : pedirConfirmarCancelacion)(citas[indice]);
        return;
      }

      // 1. SOLICITUD DE CANCELACIÓN ("cancelar", "cancelar cita", etc.)
      if (texto.includes('cancelar') || texto.includes('cancelo') || INTENCION.cancelar.test(textoN)) {
        try {
          const cita = await buscarCitaClienteAsync();
          if (cita) {
            await pedirConfirmarCancelacion(cita);
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
              `No encontramos citas activas asociadas a este número de WhatsApp. Si necesitas agendar una nueva, puedes hacerlo aquí:\n👉 ${linkReservas()}`
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

          // Sin cita activa no hay nada que cambiar: ofrecer reservar una nueva
          if (!cita || !cita.tokenPublico) {
            await enviarMensajeHumano(sock, remitente,
              `No encontramos una cita activa con este número para cambiar.\n\n` +
              `📅 Si quieres, reserva una nueva aquí:\n👉 ${linkReservas()}`);
            return;
          }

          await enviarEnlaceReagendar(cita);
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
        if (cita.estado !== 'Confirmada') await cambiarEstadoCita(cita.id, 'Confirmada');
        // Siempre el mismo mensaje: para el cliente, responder SI es confirmar su asistencia
        await enviarMensajeHumano(sock, remitente,
          `¡Listo ${nombre}! Tu cita quedó *confirmada* ✅\n\n` +
          `${iconoCategoria(cita.servicio)} ${cita.servicio}\n📅 ${fechaLegible(cita.fecha)} a las ${cita.hora}\n\n` +
          `¡Te esperamos! 💈`);
        return;
      }

      // 3b. Respondió "No" (u otro "no" suelto): no es ninguna de las opciones. Si tiene una cita,
      // se le explica qué responder en vez de mostrarle el menú general. Nada se cancela con un "no".
      if (INTENCION.negacion.test(textoN)) {
        const cita = await buscarCitaClienteAsync();
        if (cita) {
          saludoPendiente.delete(remitente);
          await enviarMensajeHumano(sock, remitente, mensajeRespuestaNoValida(cita));
          return;
        }
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
        const palabras = String(regla.palabrasClave || '').split(',').map(p => p.trim().toLowerCase());
        if (palabras.some(p => p && texto.includes(p))) {
          await enviarMensajeHumano(sock, remitente, regla.respuesta);
          return;
        }
      }

      // Regresar al menú principal con 0 o inicio
      if (soloNumeros === '0' || pideMenuExplicito(textoN) || textoN === 'volver' || textoN === 'inicio') {
        estadoCliente.set(remitente, { nivel: 'INICIO' });
        ultimoMenuMostrado.set(remitente, Date.now());
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

      // 4b. Mis citas (opción 4): ver las próximas citas y reagendar o cancelar
      if (soloNumeros === '4' || INTENCION.misCitas.test(textoN)) {
        const citas = await buscarMisCitasAsync();
        if (!citas) {
          await enviarMensajeHumano(sock, remitente, telSoloDigitos
            ? `😕 No pudimos consultar tus citas en este momento. Inténtalo de nuevo en unos minutos, o el barbero te ayudará por este chat.`
            : `😕 No pudimos identificar tu número de WhatsApp para buscar tus citas. El barbero te ayudará personalmente por este chat en cuanto pueda.`);
          return;
        }
        if (!citas.length) {
          estadoCliente.set(remitente, { nivel: 'INICIO' });
          await enviarMensajeHumano(sock, remitente,
            `📭 No tienes citas próximas con este número.\n\n` +
            `📅 Reserva aquí en menos de un minuto:\n👉 ${linkReservas()}\n\n` +
            `📖 _Tu historial de citas está en tu cuenta:_\n👉 ${linkCuenta()}\n\n` +
            `_Escribe *MENÚ* para ver todas las opciones._`);
          return;
        }
        estadoCliente.set(remitente, { nivel: 'MIS_CITAS', citas, desde: ahora });
        await enviarMensajeHumano(sock, remitente, mensajeMisCitas(citas));
        return;
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
      // Si escribe "Oe" "Oe" seguido, el menú sale una sola vez (con MENÚ sí se le repite siempre)
      if (INTENCION.saludo.test(textoN) && !INTENCION.gracias.test(textoN)) {
        if (menuMostradoHacePoco(remitente, ahora)) return;
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

      // 8. Métodos de Pago (opción 5)
      if (
        soloNumeros === '5' ||
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
      if (jid) {
        saludoPendiente.delete(jid);
        // Solo al terminar el mensaje del cliente (no cuando llega uno del barbero en medio)
        if (!m?.messages?.[0]?.key?.fromMe) ordenesAlBot.delete(jid);
      }
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

  if (await marcaGuardada('bf-anuncio', fechaIso)) { ultimoDiaAnuncioEnviado = fechaIso; return null; }
  ultimoDiaAnuncioEnviado = fechaIso;
  guardarMarca('bf-anuncio', fechaIso);
  const texto = armarAnuncioMatutino(data);
  await enviarMensajeHumano(socketActivo, jidBarbero, texto);
  console.log(`[Anuncio Matutino Enviado] ${fechaIso}`);
  return texto;
}

let revisandoAnuncio = false;
const cronAnuncioMatutino = setInterval(() => {
  if (revisandoAnuncio) return;
  revisandoAnuncio = true;
  revisarAnuncioMatutino().catch(err => console.error('Error en anuncio matutino:', err.message)).finally(() => { revisandoAnuncio = false; });
}, 60 * 1000);

// ----------------- CRON: RECORDATORIOS ANTES DE LA CITA -----------------
let revisandoRecordatorios = false;
const cronRecordatorios = setInterval(() => {
  if (revisandoRecordatorios) return;
  revisandoRecordatorios = true;
  revisarRecordatorios().catch(err => console.error('Error en recordatorios:', err.message)).finally(() => { revisandoRecordatorios = false; });
}, 5 * 60 * 1000);

if (MODO_PRUEBA || MODO_GESTOR) {
  clearInterval(cronAnuncioMatutino);
  clearInterval(cronRecordatorios);
  if (MODO_GESTOR) import('./gestor.js');
} else {
  iniciarBot();
}
