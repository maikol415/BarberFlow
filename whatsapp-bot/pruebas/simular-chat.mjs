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
  manejarNotificarCita,
  manejarNotificarCancelacion,
  revisarRecordatorios,
  urlCalificarCita,
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
const ana = { remoteJid: '88001122334455@lid', senderPn: `${dig(telAna)}@s.whatsapp.net` };
const bob = { remoteJid: `${dig(telBob)}@s.whatsapp.net` };
const vieja = { remoteJid: `${dig(telVieja)}@s.whatsapp.net` };
const anonimo = { remoteJid: '99887766554433@lid' };

let r;

r = await cliente(ana, 'Hola, quiero cancelar mi cita');
comprobar('Chat @lid: encuentra la cita usando senderPn', r, ['encontramos tu cita', manana, citaAnaManana.hora]);

r = await cliente(ana, 'a qué hora abren?');
comprobar('Respuesta ambigua: vuelve a preguntar 1 o 2', r, ['responde *1*', '*2*']);

r = await cliente(ana, 'no, no quiero cancelar');
comprobar('"no, no quiero cancelar" mantiene la cita', r, ['sigue firme']);

r = await cliente(ana, 'sí');
comprobar('Un "sí" después NO cancela (estado cerrado)', r, ['reconfirmado']);

r = await cliente({ remoteJid: ana.remoteJid }, 'cancelar');
comprobar('Mismo @lid sin senderPn: recuerda el número', r, ['encontramos tu cita', manana]);

r = await cliente(ana, '1️⃣');
comprobar('Responder 1️⃣ cancela la cita', r, ['cancelada correctamente', manana]);

r = await cliente(ana, 'cancelar');
comprobar('Luego ofrece la siguiente cita pendiente', r, ['encontramos tu cita', pasado, citaAnaPasado.hora]);
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

// Recordatorio: simular que faltan 2 horas para la cita de Carla
const [ma, mm, md] = manana.split('-').map(Number);
const mediodia = Date.UTC(ma, mm - 1, md, 5, minCarla - 120);
enviados.length = 0;
let recordados = await revisarRecordatorios(mediodia);
comprobar('Recordatorio 2 h antes de la cita', recordados.includes(citaCarla.id) ? todo() : 'no enviado', ['Te recordamos tu cita', citaCarla.hora]);
recordados = await revisarRecordatorios(mediodia + 5 * 60000);
comprobar('No repite el recordatorio', recordados.includes(citaCarla.id) ? 'repetido' : 'ok', ['ok']);
recordados = await revisarRecordatorios(Date.UTC(ma, mm - 1, md, 5, minCarla - 300));
comprobar('No recuerda con demasiada anticipación', recordados.includes(citaCarla.id) ? 'enviado' : 'ok', ['ok']);

console.log(fallos === 0 ? '\nTodo OK ✅' : `\n${fallos} prueba(s) fallaron ❌`);
process.exit(fallos === 0 ? 0 : 1);
