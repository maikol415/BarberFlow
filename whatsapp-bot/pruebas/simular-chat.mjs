// Simulador de conversaciones del bot SIN conectar WhatsApp.
// Usa la lógica real de bot.js (procesarMensajeEntrante) contra una API LOCAL de BarberFlow.
//
// Uso (con la API corriendo en local y la misma BOT_API_KEY):
//   BARBERFLOW_API_URL=http://localhost:5099/api/public BOT_API_KEY=clave node pruebas/simular-chat.mjs
//
// Crea citas de prueba en la API, por eso se niega a correr contra un servidor que no sea localhost.

process.env.BOT_MODO_PRUEBA = '1';
const API = process.env.BARBERFLOW_API_URL || 'http://localhost:5099/api/public';
const SLUG = process.env.BARBERIA_SLUG || 'barberia-jr';

if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(API)) {
  console.error(`❌ Por seguridad el simulador solo corre contra una API local (recibido: ${API}).`);
  process.exit(1);
}

const {
  procesarMensajeEntrante,
  armarAnuncioMatutino,
  revisarAnuncioMatutino,
  iconoCategoria,
  manejarNotificarCita,
  manejarNotificarCancelacion,
  revisarRecordatorios,
  urlCalificarCita,
  normalizarTexto,
  avisoDeHoy,
  INTENCION,
  probarConversacion,
  asegurarOpcionReagendar,
  horasDeRecordatorio,
  aplicarPlantilla,
  respuestaAgradecimiento,
  manejarNotificarImprevisto,
  mensajeImprevisto,
  manejarNotificarCambioHora,
  manejarEnviarCodigo,
  manejarNotificarListaEspera,
  guardarMensajeEnviado,
  mensajeEnviadoParaReenviar,
  pideMenuExplicito,
  __usarSocketDePrueba
} = await import('../bot.js');

// ---------- WhatsApp falso ----------
const enviados = [];
const lidsFalsos = {};
const sockFalso = {
  sendMessage: async (jid, contenido) => { enviados.push({ jid, texto: contenido.text || '' }); },
  sendPresenceUpdate: async () => {},
  // Como WhatsApp real: devuelve también el ID anónimo (@lid) del número si lo conocemos
  onWhatsApp: async (num) => [{ exists: true, jid: `${num}@s.whatsapp.net`, lid: lidsFalsos[num] }]
};

let contador = 0;
async function cliente(key, texto, tipo = 'notify') {
  enviados.length = 0;
  await procesarMensajeEntrante(sockFalso, {
    type: tipo,
    messages: [{ key: { fromMe: false, id: `SIM${++contador}`, ...key }, message: { conversation: texto } }]
  });
  return enviados.filter(e => e.jid === key.remoteJid).map(e => e.texto).join('\n---\n');
}

// ---------- Utilidades ----------
// k-ésimo día hábil (lunes a sábado) a partir de mañana, en hora de Colombia
function diaHabil(k) {
  let d = 0, cuenta = 0, fecha;
  while (cuenta < k) {
    d++;
    fecha = fechaColombia(d);
    if (new Date(fecha + "T12:00:00Z").getUTCDay() !== 0) cuenta++;
  }
  return fecha;
}

function fechaColombia(diasDesdeHoy) {
  const d = new Date(Date.now() - 5 * 3600 * 1000 + diasDesdeHoy * 86400 * 1000);
  return d.toISOString().slice(0, 10);
}

// Crea una cita de prueba. Si la hora preferida ya está ocupada (por corridas anteriores),
// prueba los siguientes horarios del día hasta encontrar uno libre.
const HORARIOS = [];
for (let m = 9 * 60; m <= 19 * 60; m += 20) {
  const h = Math.floor(m / 60), h12 = h % 12 || 12;
  HORARIOS.push(`${String(h12).padStart(2, '0')}:${String(m % 60).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`);
}
async function crearCita(telefono, nombre, fecha, horaPreferida) {
  const barberia = await (await fetch(`${API}/barberia/${SLUG}`)).json();
  const desde = Math.max(0, HORARIOS.indexOf(horaPreferida));
  let ultimoError = '';
  for (const hora of [...HORARIOS.slice(desde), ...HORARIOS.slice(0, desde)]) {
    const res = await fetch(`${API}/citas`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ barberiaSlug: SLUG, servicioId: barberia.servicios[0].id, nombreCliente: nombre, telefonoCliente: telefono, fecha, hora })
    });
    if (res.ok) return { ...(await res.json()), hora };
    ultimoError = `${res.status} ${await res.text()}`;
    if (!ultimoError.includes('ya fue reservado')) break;
  }
  throw new Error(`No se pudo crear la cita de prueba: ${ultimoError}`);
}

let fallos = 0;
function comprobar(nombre, respuesta, debeContener) {
  const ok = debeContener.every(t => respuesta.toLowerCase().includes(t.toLowerCase()));
  console.log(`${ok ? '✅' : '❌'} ${nombre}`);
  if (!ok) {
    fallos++;
    console.log(`   Esperaba: ${JSON.stringify(debeContener)}\n   Respuesta: ${JSON.stringify(respuesta.slice(0, 300))}`);
  }
}

// ---------- Escenarios ----------
const base = Math.floor(1000000 + Math.random() * 8999999);
const telAna = `+57300${base}`;       // cliente colombiano
const telBob = `+1305${base}`;        // cliente de USA (mismo final que Ana)
const telVieja = `+57311${base}`;     // solo tiene una cita pasada

const manana = diaHabil(1);
const pasado = diaHabil(2);
const citaAnaPasado = await crearCita(telAna, 'Ana Prueba', pasado, '04:00 PM');
const citaAnaManana = await crearCita(telAna, 'Ana Prueba', manana, '10:00 AM');
const citaBob = await crearCita(telBob, 'Bob Prueba', manana, '11:20 AM');
// La API ya no acepta citas en fechas pasadas: "vieja" queda sin citas activas
let rechazoPasada = '';
try { await crearCita(telVieja, 'Vieja Prueba', fechaColombia(-3), '09:00 AM'); } catch (e) { rechazoPasada = e.message; }

const dig = t => t.replace(/\D/g, '');
const legible = iso => new Date(iso + 'T12:00:00Z').toLocaleDateString('es-CO', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' });
const ana = { remoteJid: '88001122334455@lid', senderPn: `${dig(telAna)}@s.whatsapp.net` };
const bob = { remoteJid: `${dig(telBob)}@s.whatsapp.net` };
const vieja = { remoteJid: `${dig(telVieja)}@s.whatsapp.net` };
const anonimo = { remoteJid: '99887766554433@lid' };

let r;

r = await cliente(ana, 'Hola, quiero cancelar mi cita');
comprobar('Chat @lid: encuentra la cita usando senderPn', r, ['encontramos tu cita', legible(manana), citaAnaManana.hora]);

r = await cliente(ana, 'a qué hora abren?');
comprobar('Respuesta ambigua: vuelve a preguntar 1 o 2', r, ['responde *1*', '*2*']);

r = await cliente(ana, 'no, no quiero cancelar');
comprobar('"no, no quiero cancelar" mantiene la cita', r, ['sigue firme']);

r = await cliente(ana, 'sí');
comprobar('Un "sí" después NO cancela: confirma la asistencia', r, ['confirmada']);

r = await cliente({ remoteJid: ana.remoteJid }, 'cancelar');
comprobar('Mismo @lid sin senderPn: recuerda el número', r, ['encontramos tu cita', legible(manana)]);

r = await cliente(ana, '1️⃣');
comprobar('Responder 1️⃣ cancela la cita', r, ['cancelada correctamente', legible(manana)]);

r = await cliente(ana, 'cancelar');
comprobar('Luego ofrece la siguiente cita pendiente', r, ['encontramos tu cita', legible(pasado), citaAnaPasado.hora]);
await cliente(ana, '2');

r = await cliente(bob, 'cancelar');
comprobar('+1 con mismo final que +57: ve solo su cita', r, ['encontramos tu cita', citaBob.hora]);
await cliente(bob, 'no');

r = await cliente(vieja, 'cancelar');
comprobar('La API rechaza citas en fechas pasadas', rechazoPasada, ['ya pasó']);
comprobar('Sin citas activas: mensaje claro', r, ['no encontramos citas activas']);

r = await cliente(anonimo, 'cancelar');
comprobar('@lid sin número conocido: mensaje claro', r, ['no pudimos identificar tu número']);

r = await cliente(ana, 'cancelar', 'append');
comprobar('Ignora mensajes de historial (append)', r === '' ? 'ignorado' : r, ['ignorado']);

r = await cliente(ana, 'reagendar');
const tokenReagendar = (r.match(/reagendar=([0-9a-f]{32})\b/) || [])[1];
comprobar('Reagendar: link con el token de la cita (no el id)', tokenReagendar ? 'ok' : r, ['ok']);

// ---------- Enlaces públicos por token (reseña / reagendar) ----------
const getJson = async (url, opciones) => { const res = await fetch(url, opciones); return { status: res.status, data: await res.json().catch(() => null) }; };
const postJson = (url, body) => getJson(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

let g = await getJson(`${API}/cita-resena/${citaAnaPasado.id}`);
comprobar('El id secuencial ya no abre datos de la cita', String(g.status), ['404']);
g = await getJson(`${API}/cita-resena/${tokenReagendar}`);
comprobar('El token abre la cita correcta', g.status === 200 && !('id' in (g.data || {})) ? JSON.stringify(g.data) : `${g.status} ${JSON.stringify(g.data)}`, ['Ana Prueba', pasado]);
comprobar('Cita futura: todavía no se puede calificar', g.data?.puedeCalificar === false ? 'ok' : JSON.stringify(g.data), ['ok']);
g = await postJson(`${API}/calificar-cita`, { token: tokenReagendar, estrellas: 5, comentario: 'antes de tiempo' });
comprobar('Rechaza reseña antes de la cita', String(g.status), ['400']);
g = await postJson(`${API}/calificar-cita`, { citaId: citaAnaPasado.id, estrellas: 5 });
comprobar('Rechaza reseña por id (sin token)', g.status === 400 || g.status === 404 ? 'ok' : String(g.status), ['ok']);

// Bob acaba de mantener su cita: un "1" suelto podría ser "me arrepentí, cancela" → se le vuelve a preguntar
r = await cliente(bob, '1');
comprobar('Tras mantener la cita, "1" vuelve a preguntar y ofrece MENÚ', r, ['¿Cambiaste de opinión', 'Escribe *MENÚ*']);
r = await cliente(bob, 'menú');
r = await cliente(bob, '1');
comprobar('Opción 1 envía el enlace de reserva (no repite el menú)', r, ['Reserva tu cita en línea', `/${SLUG}`]);

const nuevo2 = { remoteJid: `5730088${base}@s.whatsapp.net` };
r = await cliente(nuevo2, 'cuánto vale el corte?');
comprobar('Primer mensaje con intención clara: saludo corto + respuesta directa', r, ['¡Hola! 👋', 'Servicios y precios']);
const nuevo3 = { remoteJid: `5730099${base}@s.whatsapp.net` };
r = await cliente(nuevo3, 'tienen parqueadero?');
comprobar('Primer mensaje que no entiende: bienvenida + menú + aviso del barbero', r, ['Bienvenid', 'el barbero te responderá']);

// (un "hola" aquí no repetiría el menú: Bob lo acaba de ver; MENÚ sí lo muestra siempre)
r = await cliente(bob, 'menú');
comprobar('MENÚ muestra el menú principal', r, ['Escribe solo el número', '*1* 📅', 'Servicios y precios', '*4* 🗓️ Mis citas', '*5* 💳', 'MENÚ']);

r = await cliente(bob, '2');
comprobar('Menú de servicios con íconos por categoría', r, ['Servicios y precios', '✂️ Cortes']);

const nuevo = { remoteJid: `5730077${base}@s.whatsapp.net` };
r = await cliente(nuevo, '5');
comprobar('Conversación que empieza con "5": primero saluda con el menú', r, ['Bienvenid', '*5* 💳']);
r = await cliente(nuevo, '5');
comprobar('Ya en la conversación, "5" muestra las formas de pago', r, ['Formas de pago']);
r = await cliente(nuevo, '4');
comprobar('"4" sin citas: lo dice y ofrece reservar', r, ['No tienes citas próximas', `/${SLUG}`]);
r = await cliente(nuevo, 'a las 3 tienen cupo?');
comprobar('"a las 3..." no abre la opción 3 por error', /Dónde estamos/.test(r) ? 'abrió ubicación' : 'ok', ['ok']);
r = await cliente(nuevo, 'a qué hora abren?');
comprobar('"a qué hora abren" responde horario y ubicación', r, ['Dónde estamos']);

comprobar('Ícono de uñas para servicios de uñas', iconoCategoria('Arreglo de uñas'), ['💅']);
comprobar('Ícono de barba', iconoCategoria('Diseño de Barba'), ['🧔']);
comprobar('Ícono facial', iconoCategoria('Limpieza facial profunda'), ['✨']);

// ---------- Webhooks de la API y tareas automáticas ----------
__usarSocketDePrueba(sockFalso);
const todo = () => enviados.map(e => `[${e.jid}] ${e.texto}`).join('\n---\n');
const telCarla = `+57315${base}`;
const citaCarla = await crearCita(telCarla, 'Carla Prueba', manana, '02:20 PM');
const minCarla = (() => { const [hh, mmm] = citaCarla.hora.split(/[: ]/); let h = +hh % 12; if (/PM/.test(citaCarla.hora)) h += 12; return h * 60 + +mmm; })();
// El token solo viaja en el aviso API ➔ bot; aquí se consulta con la clave del bot
const citaCarlaBot = (await getJson(`${API}/bot/${SLUG}/citas-cliente/${dig(telCarla)}`, { headers: { 'X-Bot-Key': process.env.BOT_API_KEY || '' } })).data || {};
comprobar('La API del bot entrega el token de la cita', /^[0-9a-f]{32}$/.test(citaCarlaBot.tokenPublico || '') ? 'ok' : JSON.stringify(citaCarlaBot), ['ok']);
comprobar('Link de reseña con slug y token', urlCalificarCita(citaCarlaBot.tokenPublico), [`/${SLUG}?calificar=${citaCarlaBot.tokenPublico}`]);
const payloadBase = {
  citaId: citaCarla.id, tokenPublico: citaCarlaBot.tokenPublico, codigoReserva: citaCarla.codigoReserva, barberiaSlug: SLUG, barberiaNombre: 'Barbería de prueba',
  barberiaDireccion: 'Calle 1', nombreCliente: 'Carla Prueba', telefonoCliente: telCarla, servicio: 'Corte',
  fecha: manana, hora: citaCarla.hora, total: 20000, duracionMinutos: 40
};

enviados.length = 0;
let w = await manejarNotificarCita({ ...payloadBase, barberiaSlug: 'otra-barberia' });
comprobar('Ignora reservas de otra barbería', w.enviado === false && enviados.length === 0 ? 'ignorado' : JSON.stringify(w), ['ignorado']);

enviados.length = 0;
w = await manejarNotificarCita(payloadBase);
const estadoTrasAviso = await (await fetch(`${API}/bot/${SLUG}/cita/${citaCarla.id}`, { headers: { 'X-Bot-Key': process.env.BOT_API_KEY } })).json();
comprobar('Tras pedir confirmación la cita queda "Por confirmar"', estadoTrasAviso.estado, ['Pendiente']);
comprobar('El aviso pide responder SI', todo(), ['Responde *SI* para confirmar']);
comprobar('Confirmación de reserva con fecha legible', todo(), ['Detalles de tu Cita', 'Código', citaCarla.codigoReserva]);
const minutosEsperados = (Date.UTC(...manana.split('-').map((n, i) => i === 1 ? n - 1 : +n), 0, minCarla) + 5 * 3600e3 - Date.now()) / 60000 + 100;
comprobar('Reseña programada 1 h después de terminar la cita (no 2 h después de reservar)',
  Math.abs((w.encuestaEnMinutos || 0) - minutosEsperados) <= 2 ? 'ok' : `programada en ${w.encuestaEnMinutos} min, esperaba ~${Math.round(minutosEsperados)}`, ['ok']);

enviados.length = 0;
await manejarNotificarCita({ ...payloadBase, esReagendamiento: true });
comprobar('Mensaje especial al reagendar', todo(), ['reagendada']);

enviados.length = 0;
await manejarNotificarCancelacion({ barberiaSlug: SLUG, nombreCliente: 'Carla Prueba', servicio: 'Corte', fecha: manana, hora: citaCarla.hora });
comprobar('Avisa al barbero cuando el cliente cancela en la web', todo(), ['canceló desde la web', 'Carla Prueba']);

// Recordatorio de una cita por confirmar: pide SI
const telCarlaJid = { remoteJid: `${dig(telCarla)}@s.whatsapp.net` };
// Recordatorio: simular que faltan 2 horas para la cita de Carla
const [ma, mm, md] = manana.split('-').map(Number);
const mediodia = Date.UTC(ma, mm - 1, md, 5, minCarla - 120);
// Varios recordatorios: 1 día antes y 2 horas antes (configuración por defecto)
comprobar('Recordatorios elegidos por defecto: 1 día y 2 horas antes', horasDeRecordatorio({ horasRecordatorios: '24,2' }).join(','), ['24,2']);
comprobar('Recordatorios: ignora valores raros y ordena', horasDeRecordatorio({ horasRecordatorios: '2,99,48' }).join(','), ['48,2']);
comprobar('Recordatorios: barberías sin la opción nueva usan la anterior', horasDeRecordatorio({ horasRecordatorio: 3 }).join(','), ['3']);
enviados.length = 0;
let recordados = await revisarRecordatorios(mediodia - 22 * 3600000);
comprobar('Recordatorio 1 día antes de la cita', recordados.includes(citaCarla.id) ? enviados.map(e => e.texto).join(' | ') : 'no enviado', ['Te recordamos tu cita de mañana']);
enviados.length = 0;
recordados = await revisarRecordatorios(mediodia - 30 * 60000);
comprobar('No recuerda 2 h y media antes (espera a las 2 h justas)', recordados.includes(citaCarla.id) ? 'enviado' : 'ok', ['ok']);
enviados.length = 0;
recordados = await revisarRecordatorios(mediodia);
comprobar('Recordatorio 2 h antes de la cita (pide confirmar si falta)', recordados.includes(citaCarla.id) ? todo() : 'no enviado', ['Te recordamos tu cita', citaCarla.hora, 'Responde *SI*']);

r = await cliente(telCarlaJid, 'Si');
const estadoTrasSi = await (await fetch(`${API}/bot/${SLUG}/cita/${citaCarla.id}`, { headers: { 'X-Bot-Key': process.env.BOT_API_KEY } })).json();
comprobar('El cliente responde SI: la cita pasa a Confirmada', `${r} | ${estadoTrasSi.estado}`, ['quedó *confirmada*', '| Confirmada']);
r = await cliente(telCarlaJid, 'sí');
comprobar('Un segundo SI vuelve a decir que quedó confirmada', r, ['quedó *confirmada*']);
r = await cliente(telCarlaJid, 'No');
comprobar('Un "No" suelto explica las opciones de su cita (no muestra el menú)', r, ['no es una de las opciones', citaCarla.hora, '*SI*', '*CANCELAR*', '*REAGENDAR*']);
const estadoTrasNo = await (await fetch(`${API}/bot/${SLUG}/cita/${citaCarla.id}`, { headers: { 'X-Bot-Key': process.env.BOT_API_KEY } })).json();
comprobar('Un "No" no cancela la cita', estadoTrasNo.estado, ['Confirmada']);

// Anuncio matutino
const anuncio = armarAnuncioMatutino({ nombre: 'Barbería X', fecha: manana, citas: [
  { hora: '09:00am', nombreCliente: 'Ana', servicio: 'Corte', estado: 'Confirmada', total: 20000 },
  { hora: '10:00am', nombreCliente: 'Luis', servicio: 'Arreglo de uñas', estado: 'Pendiente', total: 35000 },
  { hora: '11:00am', nombreCliente: 'Nadie', servicio: 'Corte', estado: 'No Confirmada', total: 20000 }
] });
comprobar('Anuncio matutino: cuenta, estados, íconos y total', anuncio, ['2 citas hoy', '1 por confirmar', '⏳ *10:00am* · Luis', '💅 Arreglo de uñas', '55.000']);
comprobar('Anuncio matutino sin citas no confirmadas', anuncio.includes('Nadie') ? 'incluida' : 'ok', ['ok']);
comprobar('Anuncio matutino sin citas', armarAnuncioMatutino({ nombre: 'X', fecha: manana, citas: [] }), ['no tienes citas']);
recordados = await revisarRecordatorios(mediodia + 5 * 60000);
comprobar('No repite el recordatorio', recordados.includes(citaCarla.id) ? 'repetido' : 'ok', ['ok']);
recordados = await revisarRecordatorios(Date.UTC(ma, mm - 1, md, 5, minCarla - 300));
comprobar('No recuerda con demasiada anticipación', recordados.includes(citaCarla.id) ? 'enviado' : 'ok', ['ok']);

// Avisos al chat @lid: si el cliente ya escribió desde un chat @lid, la cita nueva le llega ahí
// (si se envía a su número, WhatsApp lo muestra como "Esperando el mensaje")
enviados.length = 0;
await manejarNotificarCita({ ...payloadBase, telefonoCliente: telAna, nombreCliente: 'Ana Prueba' });
comprobar('Aviso de cita nueva va al mismo chat @lid del cliente', enviados.map(e => e.jid).join(','), [ana.remoteJid]);

r = await cliente(vieja, 'reagendar');
comprobar('Reagendar sin cita activa: ofrece reservar una nueva', r, ['No encontramos una cita activa', `/${SLUG}`]);

// Cómo escribe la gente en Colombia / Medellín
comprobar('Normaliza "¡¡Holaaaa!!" y "Quiubooo"', `${normalizarTexto('¡¡Holaaaa!!')}|${normalizarTexto('Quiubooo parce')}`, ['hola|quiubo parce']);
for (const saludo of ['Holaaa', 'Buenaaas', 'buenas tardes', 'Quiubo', 'Oe', 'Qué más pues', 'Holi', 'Buen día', 'ey parce']) {
  comprobar(`Reconoce el saludo "${saludo}"`, INTENCION.saludo.test(normalizarTexto(saludo)) ? 'saludo' : 'no', ['saludo']);
}
comprobar('"Cuánto valen los cortes?" es pregunta de precios', INTENCION.precios.test(normalizarTexto('Cuánto valen los cortes?')) ? 'precios' : 'no', ['precios']);
comprobar('"No voy a poder ir" es cancelar', INTENCION.cancelar.test(normalizarTexto('Uy no voy a poder ir')) ? 'cancelar' : 'no', ['cancelar']);
comprobar('"Me toca correr la cita" es reagendar', INTENCION.reagendar.test(normalizarTexto('me toca correr la cita')) ? 'reagendar' : 'no', ['reagendar']);
comprobar('"Sisas" confirma', INTENCION.confirmar.test(normalizarTexto('Sisas!!')) ? 'si' : 'no', ['si']);
comprobar('"Melo pues" es casual', INTENCION.casual.test(normalizarTexto('Melo pues')) ? 'casual' : 'no', ['casual']);
comprobar('"Hola, cuánto vale?" no es casual', INTENCION.casual.test(normalizarTexto('Hola, cuánto vale?')) ? 'casual' : 'no', ['no']);

const paisa = { remoteJid: `5730066${base}@s.whatsapp.net` };
r = await cliente(paisa, 'Quiuboooo');
comprobar('"Quiuboooo" responde con la bienvenida y el menú', r, ['Bienvenid', '*1* 📅']);
r = await cliente(paisa, 'melo pues');
comprobar('"melo pues" en plena conversación no dispara respuestas', r || 'silencio', ['silencio']);

// Motivo del bloqueo visible para el cliente
const hoyCo = fechaColombia(0);
const a10am = Date.parse(hoyCo + 'T10:00:00-05:00'), a3pm = Date.parse(hoyCo + 'T15:00:00-05:00');
comprobar('Aviso de hoy: día cerrado con motivo', avisoDeHoy({ bloqueos: [{ fecha: hoyCo, hora: 'TODO_EL_DIA', motivo: 'Festivo' }] }, a10am), ['Hoy no atendemos', 'Festivo']);
comprobar('Aviso de hoy: un descanso que ya pasó no se menciona', avisoDeHoy({ bloqueos: [{ fecha: hoyCo, hora: '12:30-14:00', motivo: 'Almuerzo' }] }, a3pm) || 'vacío', ['vacío']);
comprobar('Aviso de hoy: descanso con horas', avisoDeHoy({ bloqueos: [{ fecha: hoyCo, hora: '12:30-14:00', motivo: 'Almuerzo' }] }, a10am), ['Hoy tenemos descanso', 'Almuerzo 12:30 p. m. – 2:00 p. m.']);
comprobar('Aviso de hoy: nada si el bloqueo es otro día', avisoDeHoy({ bloqueos: [{ fecha: manana, hora: 'TODO_EL_DIA', motivo: 'Festivo' }] }) || 'vacío', ['vacío']);

// Chat de prueba del panel
let prueba = await probarConversacion({ slug: 'otra-barberia', texto: 'hola' });
comprobar('Chat de prueba: rechaza otra barbería', String(prueba.status), ['403']);
prueba = await probarConversacion({ slug: SLUG, texto: 'Buenaaas', reiniciar: true });
comprobar('Chat de prueba: responde con la bienvenida', prueba.respuestas.join(' | '), ['Bienvenid', '*1* 📅']);
prueba = await probarConversacion({ slug: SLUG, texto: '2' });
comprobar('Chat de prueba: sigue la conversación (opción 2)', prueba.respuestas.join(' | '), ['Servicios y precios']);
prueba = await probarConversacion({ slug: SLUG, texto: 'hola', reiniciar: true });
comprobar('Chat de prueba: empezar de nuevo vuelve a saludar', prueba.respuestas.join(' | '), ['Bienvenid']);
// Chat @lid SIN número (WhatsApp no manda senderPn): el bot aprende el número al enviarle la confirmación
const telMayer = `+57301${base}`;
const lidMayer = { remoteJid: `77${base}11@lid` };
lidsFalsos[dig(telMayer)] = lidMayer.remoteJid;
r = await cliente(lidMayer, 'Hola');
comprobar('Chat @lid sin número: saluda con el menú', r, ['Bienvenid']);
r = await cliente(lidMayer, 'Si');
comprobar('Chat @lid sin número y sin cita conocida: lo dice claro', r, ['No pudimos identificar tu número']);
const citaMayer = await crearCita(telMayer, 'Mayerli Prueba', pasado, '05:00 PM');
enviados.length = 0;
await manejarNotificarCita({ ...payloadBase, citaId: citaMayer.id, codigoReserva: citaMayer.codigoReserva, nombreCliente: 'Mayerli Prueba', telefonoCliente: telMayer, fecha: pasado, hora: citaMayer.hora });
comprobar('La confirmación de la cita va al mismo chat @lid donde escribió', enviados.map(e => e.jid).join(','), [lidMayer.remoteJid]);
r = await cliente(lidMayer, 'Si');
comprobar('Después responde SI desde el chat @lid: confirma su cita', r, ['quedó *confirmada*', 'Mayerli']);
r = await cliente(lidMayer, 'cancelar');
comprobar('Y CANCELAR desde el chat @lid encuentra su cita', r, ['encontramos tu cita', citaMayer.hora]);
r = await cliente(lidMayer, '2');
// El barbero responde a mano desde su celular: el bot se calla en ese chat
const escribeBarbero = (remoteJid, texto, haceSeg = 0) => procesarMensajeEntrante(sockFalso, { type: 'notify', messages: [{
  key: { remoteJid, fromMe: true, id: `HUMANO${++contador}` }, message: { conversation: texto }, messageTimestamp: Math.floor(Date.now() / 1000) - haceSeg }] });
const amiga = { remoteJid: `5730055${base}@s.whatsapp.net` };
await escribeBarbero(amiga.remoteJid, 'Hola amor, ya te muestro');
r = await cliente(amiga, 'Está bonita mor sencillo');
comprobar('Después de que el barbero escribe, el bot no se mete en el chat', r || 'silencio', ['silencio']);
r = await cliente(amiga, 'Hola');
comprobar('Ni siquiera con un saludo mientras dura la pausa', r || 'silencio', ['silencio']);
const otraAmiga = { remoteJid: `5730044${base}@s.whatsapp.net` };
await escribeBarbero(otraAmiga.remoteJid, 'mensaje viejo', 600);
r = await cliente(otraAmiga, 'Hola');
comprobar('Un mensaje viejo del barbero (historial) no pausa el bot', r, ['Bienvenid']);
await escribeBarbero(`${dig(telMayer)}@s.whatsapp.net`, 'Mayerli, te escribo yo');
r = await cliente(lidMayer, 'Hola');
comprobar('La pausa cubre también el chat @lid del mismo cliente', r || 'silencio', ['silencio']);
prueba = await probarConversacion({ slug: SLUG, texto: 'hola', reiniciar: true });
comprobar('El chat de prueba del panel no se afecta por la pausa', prueba.respuestas.join(' | '), ['Bienvenid']);
// Plantillas: el barbero asignado aparece; si no hay barbero, esa línea se quita
const plantillaPrueba = ['¡Hola {cliente}!', '💈 *Profesional:* {barbero}', '⏰ *Hora:* {hora}'].join('\n');
comprobar('Plantilla con barbero asignado', aplicarPlantilla(plantillaPrueba, { cliente: 'Mayerli', barbero: 'Diego', hora: '05:00pm' }), ['*Profesional:* Diego', '05:00pm']);
const sinBarbero = aplicarPlantilla(plantillaPrueba, { cliente: 'Mayerli', barbero: '', hora: '05:00pm' });
comprobar('Plantilla sin barbero: no deja la línea vacía', sinBarbero.includes('Profesional') ? 'quedó' : sinBarbero, ['¡Hola Mayerli!', '05:00pm']);
// Agradecimientos: respuesta amable, una sola vez cada rato
r = await cliente(bob, '2');
r = await cliente(bob, 'Gracias!!');
comprobar('"Gracias" recibe una respuesta amable con su nombre', r, ['Bob']);
comprobar('La respuesta al gracias es amable', /gusto|A ti/.test(r) ? 'amable' : r, ['amable']);
r = await cliente(bob, 'listo mil gracias parce');
comprobar('Un segundo gracias seguido no se responde (no ser cansón)', r || 'silencio', ['silencio']);
comprobar('Respuesta sin nombre si no lo conocemos', respuestaAgradecimiento('', 0), ['¡Con mucho gusto! 💈']);
// Imprevisto del barbero: cada cliente afectado recibe el aviso con el motivo y el enlace para reservar otra hora
const telImpre = `+57302${base}`;
enviados.length = 0;
const imp = await manejarNotificarImprevisto({ barberiaSlug: SLUG, barberiaNombre: 'Barbería X', motivo: 'Calamidad', citas: [{ id: 999, nombreCliente: 'lucia gómez', telefonoCliente: telImpre, servicio: 'Corte', fecha: manana, hora: '03:00pm' }] });
comprobar('Imprevisto: avisa al cliente con motivo, fecha y enlace', enviados.map(e => e.texto).join(' | '), ['Hola Lucia', 'imprevisto (Calamidad)', legible(manana), '03:00pm', 'quedó cancelada', `/${SLUG}`, 'se comunicará contigo']);
comprobar('Imprevisto: no avisa citas de otra barbería', (await manejarNotificarImprevisto({ barberiaSlug: 'otra', citas: [] })).razon || '', ['otra barbería']);
// Cita anotada por el barbero en el local: confirmación sin pedir SI y la cita sigue Confirmada
const telLocal = `+57303${base}`;
const citaLocal = await crearCita(telLocal, 'Cliente Local', pasado, '05:20 PM');
enviados.length = 0;
await manejarNotificarCita({ ...payloadBase, citaId: citaLocal.id, codigoReserva: citaLocal.codigoReserva, nombreCliente: 'Cliente Local', telefonoCliente: telLocal, fecha: pasado, hora: citaLocal.hora, creadaPorBarbero: true });
const estadoLocal = await (await fetch(`${API}/bot/${SLUG}/cita/${citaLocal.id}`, { headers: { 'X-Bot-Key': process.env.BOT_API_KEY } })).json();
comprobar('Cita del local: no pide SI y queda Confirmada', `${/Responde *SI*/.test(enviados.map(e => e.texto).join(' ')) ? 'pide SI' : 'sin SI'} | ${estadoLocal.estado}`, ['sin SI', '| Confirmada']);
comprobar('Imprevisto con motivo genérico no lo repite', mensajeImprevisto({ nombreCliente: 'Ana', fecha: manana, hora: '03:00pm' }, 'X', 'Imprevisto'), ['Por un imprevisto el barbero']);
comprobar('Imprevisto con emoji de almuerzo no lo repite', mensajeImprevisto({ nombreCliente: 'Ana', fecha: manana, hora: '03:00pm' }, 'X', '🍱 Almuerzo'), ['Por un imprevisto el barbero']);
// Cita corrida por el barbero: el cliente recibe la hora anterior, la nueva y el enlace para reagendar
const telCorrida = `+57304${base}`;
enviados.length = 0;
await manejarNotificarCambioHora({ barberiaSlug: SLUG, barberiaNombre: 'Barbería X', citas: [{ id: 77, nombreCliente: 'carlos ruiz', telefonoCliente: telCorrida, servicio: 'Corte', fecha: manana, horaAnterior: '05:20pm', horaNueva: '05:50pm', tokenPublico: 'abc123' }] });
comprobar('Cita corrida: avisa hora anterior, nueva y enlace para reagendar', enviados.map(e => e.texto).join(' | '), ['Hola Carlos', legible(manana), '~05:20pm~', '*05:50pm*', 'reagendar=abc123']);
// Código de recuperación de clave por WhatsApp
const telCodigo = `+57305${base}`;
enviados.length = 0;
let cod = await manejarEnviarCodigo({ barberiaSlug: SLUG, barberiaNombre: 'Barbería X', telefono: telCodigo, nombre: 'sara lopez', codigo: '482913', para: 'cliente' });
comprobar('Código para el cliente: llega con su nombre, el código y la advertencia', enviados.map(e => e.texto).join(' | '), ['Hola Sara', '*482913*', 'Vence en 10 minutos', 'Si no lo pediste']);
enviados.length = 0;
cod = await manejarEnviarCodigo({ barberiaSlug: SLUG, telefono: telCodigo, codigo: '12ab', para: 'cliente' });
comprobar('Código mal formado: no se envía nada', `${cod.enviado}|${enviados.length}`, ['false|0']);
cod = await manejarEnviarCodigo({ barberiaSlug: 'otra', telefono: telCodigo, codigo: '123456' });
comprobar('Código de otra barbería: no se envía', cod.razon || '', ['otra barbería']);
// Lista de espera: se liberó un turno y se le avisa al cliente con el enlace a ese día y servicio
const telEspera = `+57306${base}`;
enviados.length = 0;
await manejarNotificarListaEspera({ barberiaSlug: SLUG, barberiaNombre: 'Barbería X', nombreCliente: 'maria paz', telefonoCliente: telEspera, servicioId: 5, fecha: manana, hora: '03:20pm' });
comprobar('Lista de espera: avisa el turno libre con enlace al día y servicio', enviados.map(e => e.texto).join(' | '), ['Hola Maria', 'Se liberó un turno', legible(manana), '3:20', 'lista de espera', `/${SLUG}?fecha=${manana}&servicio=5`]);
comprobar('Lista de espera: no avisa por otra barbería', (await manejarNotificarListaEspera({ barberiaSlug: 'otra', telefonoCliente: telEspera })).razon || '', ['otra barbería']);
// Pregunta pendiente: tras la confirmación ("Responde SI / CANCELAR") solo valen esas opciones
const telPepe = `+57304${base}`;
const pepe = { remoteJid: `${telPepe.replace(/\D/g, '')}@s.whatsapp.net` };
const citaPepe = await crearCita(telPepe, 'El Pepe', pasado, '06:00 PM');
await manejarNotificarCita({ ...payloadBase, citaId: citaPepe.id, codigoReserva: citaPepe.codigoReserva, nombreCliente: 'El Pepe', telefonoCliente: telPepe, fecha: pasado, hora: citaPepe.hora });
for (const t of ['Hola', 'amén', 'No', '1']) {
  r = await cliente(pepe, t);
  comprobar(`Pregunta pendiente: "${t}" recibe las opciones SI / CANCELAR`, r, ['no es una de las opciones', citaPepe.hora, '*SI*', '*CANCELAR*']);
}
const estadoPepe = await (await fetch(`${API}/bot/${SLUG}/cita/${citaPepe.id}`, { headers: { 'X-Bot-Key': process.env.BOT_API_KEY } })).json();
comprobar('Pregunta pendiente: otras palabras no cambian la cita (sigue por confirmar)', estadoPepe.estado, ['Pendiente']);
r = await cliente(pepe, 'Si');
comprobar('Pregunta pendiente: SI confirma la cita', r, ['quedó *confirmada*', 'El Pepe']);
r = await cliente(pepe, 'Hola');
comprobar('Ya respondió: un "hola" vuelve a mostrar el menú normal', r, ['Bienvenid']);
// MENÚ sale de la pregunta pendiente
await manejarNotificarCita({ ...payloadBase, citaId: citaPepe.id, codigoReserva: citaPepe.codigoReserva, nombreCliente: 'El Pepe', telefonoCliente: telPepe, fecha: pasado, hora: citaPepe.hora });
r = await cliente(pepe, 'menú');
comprobar('Pregunta pendiente: MENÚ muestra las opciones generales', r, ['Escribe solo el número']);
// CANCELAR sí funciona con la pregunta pendiente
await manejarNotificarCita({ ...payloadBase, citaId: citaPepe.id, codigoReserva: citaPepe.codigoReserva, nombreCliente: 'El Pepe', telefonoCliente: telPepe, fecha: pasado, hora: citaPepe.hora });
r = await cliente(pepe, 'CANCELAR');
comprobar('Pregunta pendiente: CANCELAR pide confirmar la cancelación', r, ['encontramos tu cita', citaPepe.hora]);
r = await cliente(pepe, '2');

// Mis citas (opción 4): con dos citas, elegir cuál reagendar o cancelar
const citaPepe2 = await crearCita(telPepe, 'El Pepe', manana, '06:20 PM');
r = await cliente(pepe, '4');
comprobar('Mis citas: muestra sus próximas citas y las opciones', r, ['Tus próximas citas', citaPepe.hora, citaPepe2.hora, '*1* 🔄 Reagendar', '*2* ❌ Cancelar', '*0* 🏠', 'historial de citas', 'cuenta.html?b=']);
r = await cliente(pepe, 'hola');
comprobar('Mis citas: una palabra que no es opción recuerda las opciones', r, ['no es válida', '*1*', '*2*', '*0*']);
r = await cliente(pepe, '1');
comprobar('Mis citas: con varias, pregunta cuál reagendar', r, ['¿Cuál cita quieres *reagendar*', '*1.*', '*2.*']);
r = await cliente(pepe, '9');
comprobar('Mis citas: número que no existe', r, ['no es válida', 'del *1* al *2*']);
r = await cliente(pepe, '2');
comprobar('Mis citas: manda el enlace para reagendar la cita elegida', r, ['Cambiar tu cita', 'reagendar=', citaPepe.hora]);
r = await cliente(pepe, 'mis citas');
r = await cliente(pepe, '2');
r = await cliente(pepe, '1');
comprobar('Mis citas: cancelar la primera pide confirmar', r, ['¿Seguro que quieres cancelarla?', citaPepe2.hora]);
r = await cliente(pepe, '1');
comprobar('Mis citas: y la cancela', r, ['cancelada correctamente']);
r = await cliente(pepe, '4');
comprobar('Mis citas: con una sola cita, opciones directas', r, ['Tu próxima cita', citaPepe.hora, '(cambiar día u hora)']);
r = await cliente(pepe, '0');
comprobar('Mis citas: 0 vuelve al menú', r, ['Escribe solo el número']);

// Plantilla del barbero sin REAGENDAR: se agrega debajo de CANCELAR con el mismo estilo
const plantillaSinReagendar = '¿Necesitas gestionar tu turno?\n• Responde *SI* para reconfirmar asistencia ✅\n• Responde *CANCELAR* si se te presentó un imprevisto ❌\n━━━━━━━━━━\n¡Te esperamos!';
comprobar('Plantilla sin REAGENDAR: se agrega debajo de CANCELAR', asegurarOpcionReagendar(plantillaSinReagendar),
  ['❌\n• Responde *REAGENDAR* si quieres cambiar el día o la hora 🔄\n━━━━']);
comprobar('Recordatorio sin CANCELAR ni REAGENDAR: se agrega antes de la última línea', asegurarOpcionReagendar('Hola\n━━━━━━\nResponde *CONFIRMO* ✅\n━━━━━━\n¡Nos vemos!'),
  ['CONFIRMO* ✅\n👉 Si no puedes asistir, responde *CANCELAR* o *REAGENDAR*.\n━━━━━━\n¡Nos vemos!']);

// ---------- "Oe" "Oe": el menú sale una sola vez ----------
const chatOe = { remoteJid: `5731188${base}@s.whatsapp.net` };
r = await cliente(chatOe, 'Oe');
comprobar('Primer "Oe": saluda con el menú', r, ['Bienvenid', 'Mis citas']);
r = await cliente(chatOe, 'Oe');
comprobar('Segundo "Oe" seguido: no repite el menú', r || 'silencio', ['silencio']);
r = await cliente(chatOe, 'Hola');
comprobar('Un "Hola" enseguida tampoco lo repite', r || 'silencio', ['silencio']);
r = await cliente(chatOe, 'MENÚ');
comprobar('Con MENÚ sí lo vuelve a mostrar', r, ['Mis citas', 'Formas de pago']);

// ---------- El barbero responde mientras el bot está "escribiendo..." ----------
const chatRapido = { remoteJid: `5731199${base}@s.whatsapp.net` };
await cliente(chatRapido, 'Hola');
const enviadosRapido = [];
const sockBarberoRapido = {
  ...sockFalso,
  sendMessage: async (jid, contenido) => { enviadosRapido.push({ jid, texto: contenido.text || '' }); },
  // Justo cuando el bot empieza a "escribir", el barbero contesta desde su celular
  sendPresenceUpdate: async (estado, jid) => { if (estado === 'composing') await escribeBarbero(jid, 'Quiubo parce, yo te atiendo'); }
};
await procesarMensajeEntrante(sockBarberoRapido, { type: 'notify', messages: [{
  key: { remoteJid: chatRapido.remoteJid, fromMe: false, id: `SIM${++contador}` }, message: { conversation: 'deje de ser tan serio jaja' } }] });
comprobar('Si el barbero responde mientras el bot escribe, el bot no envía su aviso',
  enviadosRapido.map(e => e.texto).join(' ') || 'silencio', ['silencio']);

// ---------- Se arrepiente: eligió "2. Mantener" y luego escribe "1" ----------
const telMayer2 = `+57312${base}`;
const chatMayer2 = { remoteJid: `${dig(telMayer2)}@s.whatsapp.net` };
const citaMayer2 = await crearCita(telMayer2, 'Mayerli Rv', pasado, '05:00 PM');
await cliente(chatMayer2, 'Hola');
r = await cliente(chatMayer2, 'Cancelar');
comprobar('Arrepentida: CANCELAR pide confirmar', r, ['¿Seguro que quieres cancelarla?']);
r = await cliente(chatMayer2, '2');
comprobar('Arrepentida: "2" mantiene la cita', r, ['sigue firme']);
r = await cliente(chatMayer2, '1');
comprobar('Arrepentida: un "1" enseguida vuelve a preguntar (no cancela de una)', r, ['¿Cambiaste de opinión, Mayerli Rv?', '*1*', '*2*', citaMayer2.hora]);
let estadoMayer2 = await (await fetch(`${API}/bot/${SLUG}/cita/${citaMayer2.id}`, { headers: { 'X-Bot-Key': process.env.BOT_API_KEY } })).json();
comprobar('Arrepentida: la cita sigue activa mientras no confirme', estadoMayer2.estado === 'Cancelada' ? 'cancelada' : 'activa', ['activa']);
r = await cliente(chatMayer2, '1');
comprobar('Arrepentida: con el segundo "1" sí se cancela', r, ['cancelada correctamente']);

// ---------- MENÚ funciona aunque el barbero esté hablando en el chat ----------
const chatMenuPausa = { remoteJid: `5731177${base}@s.whatsapp.net` };
await escribeBarbero(chatMenuPausa.remoteJid, 'Pero amor pon menú a ver');
r = await cliente(chatMenuPausa, 'jajaja');
comprobar('Con el barbero hablando, una charla normal no activa el bot', r || 'silencio', ['silencio']);
r = await cliente(chatMenuPausa, 'Menu');
comprobar('Con el barbero hablando, MENÚ sí muestra las opciones', r, ['Mis citas', 'Formas de pago']);
r = await cliente(chatMenuPausa, '3');
comprobar('Y luego el número de la opción también funciona', r, ['Dónde estamos']);
const chatManu = { remoteJid: `5731166${base}@s.whatsapp.net` };
await escribeBarbero(chatManu.remoteJid, 'Ya te atiendo');
r = await cliente(chatManu, 'Manù');
comprobar('Con el barbero hablando, "Manù" no se toma como MENÚ (puede ser un nombre)', r || 'silencio', ['silencio']);
r = await cliente(chatManu, 'ver el menú!');
comprobar('"ver el menú" también cuenta como MENÚ', r, ['Mis citas']);

// MENÚ escrito de muchas formas (mayúsculas, tildes, letras repetidas, signos, cortesía, errores de dedo)
const formasMenu = ['MENÚ', 'Menù', 'menü', 'Menuuu', '¿Menú?', 'menú 🙏', 'el menú', 'ver el menu', 'pásame el menú', 'menú porfa', 'menu pues', 'meni', 'Menu Menu'];
comprobar('MENÚ se reconoce escrito de muchas formas', formasMenu.filter(t => !pideMenuExplicito(normalizarTexto(t))).join(', ') || 'todas', ['todas']);
const noMenu = ['Manù', 'menudo', 'el menú de hoy está rico', 'ese menu no sirve', 'ojalá tuvieras un meno'];
comprobar('Frases que solo mencionan el menú no cuentan', noMenu.filter(t => pideMenuExplicito(normalizarTexto(t))).join(', ') || 'ninguna', ['ninguna']);

// ---------- Copia de lo enviado, para reenviarlo si un celular no lo pudo leer ----------
guardarMensajeEnviado({ key: { id: 'BOT-COPIA-1', remoteJid: '573000000000@s.whatsapp.net' }, message: { conversation: '☀️ Buenos días' } });
comprobar('Si un celular pide reenviar un mensaje, el bot tiene la copia',
  mensajeEnviadoParaReenviar({ id: 'BOT-COPIA-1', remoteJid: '573000000000@s.whatsapp.net' })?.conversation || 'nada', ['Buenos días']);
comprobar('La copia se guarda solo 1 día',
  String(mensajeEnviadoParaReenviar({ id: 'BOT-COPIA-1' }, Date.now() + 25 * 3600 * 1000) ?? 'vencida'), ['vencida']);
comprobar('Un mensaje que el bot no envió no se inventa',
  String(mensajeEnviadoParaReenviar({ id: 'NO-EXISTE' }) ?? 'nada'), ['nada']);

console.log(fallos === 0 ? '\nTodo OK ✅' : `\n${fallos} prueba(s) fallaron ❌`);
process.exit(fallos === 0 ? 0 : 1);
