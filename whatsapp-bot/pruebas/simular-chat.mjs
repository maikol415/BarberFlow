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
  __usarSocketDePrueba
} = await import('../bot.js');

// ---------- WhatsApp falso ----------
const enviados = [];
const sockFalso = {
  sendMessage: async (jid, contenido) => { enviados.push({ jid, texto: contenido.text || '' }); },
  sendPresenceUpdate: async () => {},
  onWhatsApp: async (num) => [{ exists: true, jid: `${num}@s.whatsapp.net` }]
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

r = await cliente(bob, '1');
comprobar('Opción 1 envía el enlace de reserva (no repite el menú)', r, ['Reserva tu cita en línea', 'index.html?b=']);

const nuevo2 = { remoteJid: `5730088${base}@s.whatsapp.net` };
r = await cliente(nuevo2, 'cuánto vale el corte?');
comprobar('Primer mensaje con intención clara: saludo corto + respuesta directa', r, ['¡Hola! 👋', 'Servicios y precios']);
const nuevo3 = { remoteJid: `5730099${base}@s.whatsapp.net` };
r = await cliente(nuevo3, 'tienen parqueadero?');
comprobar('Primer mensaje que no entiende: bienvenida + menú + aviso del barbero', r, ['Bienvenid', 'el barbero te responderá']);

r = await cliente(bob, 'hola');
comprobar('Saludo con menú principal', r, ['*1.*', 'Servicios y precios', 'CANCELAR']);

r = await cliente(bob, '2');
comprobar('Menú de servicios con íconos por categoría', r, ['Servicios y precios', '✂️ Cortes']);

const nuevo = { remoteJid: `5730077${base}@s.whatsapp.net` };
r = await cliente(nuevo, '4');
comprobar('Conversación que empieza con "4": primero saluda con el menú', r, ['Bienvenid', '*4.*']);
r = await cliente(nuevo, '4');
comprobar('Ya en la conversación, "4" muestra las formas de pago', r, ['Formas de pago']);
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
comprobar('Link de reseña con slug y token', urlCalificarCita(citaCarlaBot.tokenPublico), [`b=${SLUG}`, `calificar=${citaCarlaBot.tokenPublico}`]);
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
enviados.length = 0;
let recordados = await revisarRecordatorios(mediodia);
comprobar('Recordatorio 2 h antes de la cita (pide confirmar si falta)', recordados.includes(citaCarla.id) ? todo() : 'no enviado', ['Te recordamos tu cita', citaCarla.hora, 'Responde *SI*']);

r = await cliente(telCarlaJid, 'Si');
const estadoTrasSi = await (await fetch(`${API}/bot/${SLUG}/cita/${citaCarla.id}`, { headers: { 'X-Bot-Key': process.env.BOT_API_KEY } })).json();
comprobar('El cliente responde SI: la cita pasa a Confirmada', `${r} | ${estadoTrasSi.estado}`, ['quedó *confirmada*', '| Confirmada']);
r = await cliente(telCarlaJid, 'sí');
comprobar('Un segundo SI avisa que ya estaba confirmada', r, ['ya estaba confirmada']);

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
comprobar('Reagendar sin cita activa: ofrece reservar una nueva', r, ['No encontramos una cita activa', 'index.html?b=']);

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
comprobar('"Quiuboooo" responde con la bienvenida y el menú', r, ['Bienvenid', '*1.*']);
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
comprobar('Chat de prueba: responde con la bienvenida', prueba.respuestas.join(' | '), ['Bienvenid', '*1.*']);
prueba = await probarConversacion({ slug: SLUG, texto: '2' });
comprobar('Chat de prueba: sigue la conversación (opción 2)', prueba.respuestas.join(' | '), ['Servicios y precios']);
prueba = await probarConversacion({ slug: SLUG, texto: 'hola', reiniciar: true });
comprobar('Chat de prueba: empezar de nuevo vuelve a saludar', prueba.respuestas.join(' | '), ['Bienvenid']);
console.log(fallos === 0 ? '\nTodo OK ✅' : `\n${fallos} prueba(s) fallaron ❌`);
process.exit(fallos === 0 ? 0 : 1);
