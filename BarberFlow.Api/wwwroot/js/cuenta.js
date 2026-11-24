// ================== MI CUENTA (clientes de una barbería) ==================
const slug = (new URLSearchParams(location.search).get('b') || 'barberia-jr').toLowerCase();
const CLAVE_SESION = `bf_cliente_session_${slug}`;
const PAISES = [
  ['+57', '🇨🇴'], ['+1', '🇺🇸'], ['+34', '🇪🇸'], ['+52', '🇲🇽'], ['+54', '🇦🇷'],
  ['+56', '🇨🇱'], ['+51', '🇵🇪'], ['+58', '🇻🇪'], ['+593', '🇪🇨'], ['+507', '🇵🇦']
];

let sesion = null;
let citas = [];

// ---------- Utilidades ----------
function escapeHtml(valor) {
  return String(valor ?? '').replace(/[&<>"'`]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[ch]));
}

function $(id) { return document.getElementById(id); }
function mostrar(id, visible) { $(id).classList.toggle('oculto', !visible); }

function leerSesion() {
  try {
    localStorage.removeItem('bf_cliente_session'); // formato anterior (compartido entre barberías)
    const datos = JSON.parse(localStorage.getItem(CLAVE_SESION) || 'null');
    return datos && datos.token ? datos : null;
  } catch (e) { return null; }
}

function guardarSesion(datos) {
  sesion = datos;
  try { localStorage.setItem(CLAVE_SESION, JSON.stringify(datos)); } catch (e) {}
}

function borrarSesion() {
  sesion = null;
  try { localStorage.removeItem(CLAVE_SESION); } catch (e) {}
}

async function api(ruta, opciones = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opciones.headers || {}) };
  if (sesion?.token) headers.Authorization = `Bearer ${sesion.token}`;
  const res = await fetch(`/api/public${ruta}`, { ...opciones, headers });
  let data = null;
  try { data = await res.json(); } catch (e) {}
  if (res.status === 401 && sesion) {
    borrarSesion();
    avisar('Tu sesión expiró. Ingresa de nuevo.', 'error');
    mostrarVista('auth');
  }
  return { ok: res.ok, status: res.status, data };
}

function avisar(texto, tipo = 'ok') {
  const el = $('aviso');
  el.textContent = texto;
  el.className = `fixed left-1/2 transform -translate-x-1/2 bottom-6 z-50 px-4 py-3 rounded-xl text-sm font-semibold shadow-2xl aparecer ${
    tipo === 'error' ? 'bg-red-600 text-white' : 'bg-emerald-600 text-white'}`;
  clearTimeout(avisar._t);
  avisar._t = setTimeout(() => el.classList.add('oculto'), 3500);
}

function confirmar(titulo, texto, textoAceptar) {
  return new Promise(resolve => {
    $('dialogo-titulo').textContent = titulo;
    $('dialogo-texto').textContent = texto;
    $('dialogo-aceptar').textContent = textoAceptar;
    mostrar('dialogo', true);
    const cerrar = (valor) => { mostrar('dialogo', false); resolve(valor); };
    $('dialogo-aceptar').onclick = () => cerrar(true);
    $('dialogo-cancelar').onclick = () => cerrar(false);
  });
}

function formatearFecha(fechaIso) {
  const [a, m, d] = (fechaIso || '').split('-').map(Number);
  if (!a) return { dia: '', num: '', mes: '', larga: fechaIso };
  const fecha = new Date(Date.UTC(a, m - 1, d, 12));
  const opc = { timeZone: 'UTC' };
  return {
    dia: fecha.toLocaleDateString('es-CO', { ...opc, weekday: 'short' }).replace('.', ''),
    num: d,
    mes: fecha.toLocaleDateString('es-CO', { ...opc, month: 'short' }).replace('.', ''),
    larga: fecha.toLocaleDateString('es-CO', { ...opc, weekday: 'long', day: 'numeric', month: 'long' })
  };
}

function formatearHora(hora) {
  return String(hora || '').replace(/\s*(am|pm)$/i, (_, x) => ` ${x.toLowerCase() === 'am' ? 'a. m.' : 'p. m.'}`);
}

function separarTelefono(tel) {
  let limpio = String(tel || '').replace(/[^\d+]/g, '');
  if (!limpio.startsWith('+')) limpio = `+${limpio}`;
  for (const [cod] of [...PAISES].sort((x, y) => y[0].length - x[0].length)) {
    if (limpio.startsWith(cod)) return `${cod} ${limpio.slice(cod.length)}`;
  }
  return limpio;
}

function llenarPaises(selectId) {
  $(selectId).innerHTML = PAISES.map(([cod, flag]) => `<option value="${cod}">${flag} ${cod}</option>`).join('');
}

function alternarClave(inputId, boton) {
  const input = $(inputId);
  input.type = input.type === 'password' ? 'text' : 'password';
  boton.setAttribute('aria-label', input.type === 'password' ? 'Mostrar contraseña' : 'Ocultar contraseña');
}

// ---------- Vistas ----------
function mostrarVista(vista) {
  mostrar('vista-cargando', vista === 'cargando');
  mostrar('vista-auth', vista === 'auth');
  mostrar('vista-cuenta', vista === 'cuenta');
  lucide.createIcons();
}

function mostrarFormulario(cual) {
  const login = cual === 'login';
  mostrar('form-login', login);
  mostrar('form-registro', !login);
  $('tab-login').className = `py-2 rounded-lg text-sm font-bold transition ${login ? 'tab-activa' : 'tab-inactiva'}`;
  $('tab-registro').className = `py-2 rounded-lg text-sm font-bold transition ${login ? 'tab-inactiva' : 'tab-activa'}`;
  mostrar('auth-error', false);
}

function mostrarErrorAuth(texto) {
  $('auth-error').textContent = texto;
  mostrar('auth-error', true);
}

function mostrarPestana(cual) {
  const prox = cual === 'proximas';
  mostrar('lista-proximas', prox);
  mostrar('lista-historial', !prox);
  $('tab-proximas').className = `py-2.5 rounded-lg text-sm font-bold transition ${prox ? 'tab-activa' : 'tab-inactiva'}`;
  $('tab-historial').className = `py-2.5 rounded-lg text-sm font-bold transition ${prox ? 'tab-inactiva' : 'tab-activa'}`;
}

// ---------- Ingresar / crear cuenta ----------
async function ingresar(e) {
  e.preventDefault();
  const btn = $('btn-login');
  btn.disabled = true; btn.textContent = 'Ingresando...';
  const { ok, data } = await api('/clientes/login', {
    method: 'POST',
    body: JSON.stringify({
      barberiaSlug: slug,
      telefono: `${$('login-pais').value}${$('login-tel').value.replace(/\D/g, '')}`,
      password: $('login-pass').value
    })
  });
  btn.disabled = false; btn.textContent = 'Ingresar';
  if (!ok) return mostrarErrorAuth(data?.message || 'No pudimos iniciar sesión.');
  guardarSesion(data);
  await cargarCuenta();
}

async function crearCuenta(e) {
  e.preventDefault();
  const btn = $('btn-registro');
  btn.disabled = true; btn.textContent = 'Creando cuenta...';
  const { ok, data } = await api('/clientes/registro', {
    method: 'POST',
    body: JSON.stringify({
      barberiaSlug: slug,
      nombre: $('reg-nombre').value.trim(),
      telefono: `${$('reg-pais').value}${$('reg-tel').value.replace(/\D/g, '')}`,
      genero: $('reg-genero').value,
      password: $('reg-pass').value
    })
  });
  btn.disabled = false; btn.textContent = 'Crear mi cuenta';
  if (!ok) return mostrarErrorAuth(data?.message || 'No pudimos crear tu cuenta.');
  guardarSesion(data);
  avisar('¡Cuenta creada! 🎉');
  await cargarCuenta();
}

function cerrarSesion() {
  borrarSesion();
  mostrarFormulario('login');
  mostrarVista('auth');
}

async function pedirEliminarCuenta() {
  const si = await confirmar('¿Eliminar tu cuenta?', 'Tus citas seguirán registradas en la barbería, pero ya no podrás ingresar con esta cuenta.', 'Sí, eliminar');
  if (!si) return;
  const { ok, data } = await api('/clientes/me', { method: 'DELETE' });
  if (!ok) return avisar(data?.message || 'No se pudo eliminar la cuenta.', 'error');
  borrarSesion();
  avisar('Tu cuenta fue eliminada.');
  mostrarFormulario('login');
  mostrarVista('auth');
}

// ---------- Citas ----------
const ESTILO_ESTADO = {
  'Pendiente': 'bg-amber-500/10 text-amber-300 border-amber-500/30',
  'Confirmada': 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30',
  'No Confirmada': 'bg-amber-500/10 text-amber-300 border-amber-500/30',
  'Completada': 'bg-blue-500/10 text-blue-300 border-blue-500/30',
  'Cancelada': 'bg-red-500/10 text-red-300 border-red-500/30',
  'Pasada': 'bg-gray-700/40 text-gray-300 border-gray-600/40'
};

function tarjetaCita(c) {
  const f = formatearFecha(c.fecha);
  const estado = (!c.proxima && (c.estado === 'Confirmada' || c.estado === 'Pendiente')) ? 'Pasada' : c.estado;
  const TEXTO_ESTADO = { 'Pendiente': 'Por confirmar', 'No Confirmada': 'No confirmada', 'Completada': 'Atendida' };
  const acciones = c.proxima ? `
      <div class="grid grid-cols-2 gap-2 mt-4">
        <a href="/index.html?b=${encodeURIComponent(slug)}&reagendar=${encodeURIComponent(c.tokenPublico)}" class="py-2 rounded-xl text-xs font-bold text-center bg-blue-600/15 text-blue-300 border border-blue-500/30 hover:bg-blue-600/25 transition">Reagendar</a>
        <button onclick="cancelarCita(${c.id})" class="py-2 rounded-xl text-xs font-bold bg-gray-800 text-gray-300 border border-gray-700 hover:text-red-300 hover:border-red-500/40 transition">Cancelar cita</button>
      </div>` : `
      <div class="mt-3">
        <a href="/index.html?b=${encodeURIComponent(slug)}" class="text-xs font-bold text-blue-400 hover:text-blue-300">Reservar de nuevo →</a>
      </div>`;

  return `
    <article class="p-4 rounded-2xl bg-gray-900/80 border ${c.proxima ? 'border-gray-700' : 'border-gray-800'} aparecer">
      <div class="flex gap-4">
        <div class="w-14 flex-shrink-0 rounded-xl ${c.proxima ? 'bg-blue-600/15 border-blue-500/30' : 'bg-gray-800/60 border-gray-700'} border text-center py-2">
          <div class="text-[10px] uppercase font-bold ${c.proxima ? 'text-blue-300' : 'text-gray-400'}">${escapeHtml(f.dia)}</div>
          <div class="text-xl font-extrabold text-white leading-tight">${escapeHtml(f.num)}</div>
          <div class="text-[10px] uppercase font-semibold text-gray-400">${escapeHtml(f.mes)}</div>
        </div>
        <div class="min-w-0 flex-1">
          <div class="flex items-start justify-between gap-2">
            <h3 class="font-bold text-white text-sm leading-snug">${escapeHtml(c.servicio)}</h3>
            <span class="text-[10px] px-2 py-0.5 rounded-full border font-bold whitespace-nowrap ${ESTILO_ESTADO[estado] || ESTILO_ESTADO.Pasada}">${escapeHtml(TEXTO_ESTADO[estado] || estado)}</span>
          </div>
          <p class="text-xs text-gray-300 mt-1 flex items-center gap-1.5"><i data-lucide="clock" class="w-3.5 h-3.5 text-gray-500"></i> ${escapeHtml(formatearHora(c.hora))}${c.duracionMinutos ? ` · ${c.duracionMinutos} min` : ''}</p>
          <p class="text-xs text-gray-400 mt-0.5 flex items-center gap-1.5"><i data-lucide="user" class="w-3.5 h-3.5 text-gray-500"></i> ${escapeHtml(c.barbero)}</p>
          <p class="text-[11px] text-gray-500 mt-1.5"><span class="font-mono text-blue-400">${escapeHtml(c.codigoReserva)}</span> · $ ${Number(c.total || 0).toLocaleString('es-CO')}</p>
        </div>
      </div>
      ${acciones}
    </article>`;
}

function vacio(icono, titulo, texto, conBoton) {
  return `
    <div class="text-center py-12 px-6 rounded-2xl border border-dashed border-gray-800">
      <i data-lucide="${icono}" class="w-8 h-8 text-gray-600 mx-auto"></i>
      <p class="text-sm font-bold text-gray-300 mt-3">${titulo}</p>
      <p class="text-xs text-gray-500 mt-1">${texto}</p>
      ${conBoton ? `<a href="/index.html?b=${encodeURIComponent(slug)}" class="inline-block mt-4 px-4 py-2 rounded-xl text-xs font-bold bg-blue-600 text-white hover:bg-blue-500">Reservar una cita</a>` : ''}
    </div>`;
}

function renderCitas() {
  // Próximas: la más cercana primero (por fecha y hora real)
  const proximas = citas.filter(c => c.proxima);
  proximas.sort((a, b) => a.fecha === b.fecha ? minutos(a.hora) - minutos(b.hora) : a.fecha.localeCompare(b.fecha));
  const historial = citas.filter(c => !c.proxima);

  $('cont-proximas').textContent = proximas.length;
  $('cont-historial').textContent = historial.length;

  $('lista-proximas').innerHTML = proximas.length
    ? proximas.map(tarjetaCita).join('')
    : vacio('calendar-plus', 'No tienes citas próximas', 'Cuando reserves con tu número aparecerán aquí.', true);
  $('lista-historial').innerHTML = historial.length
    ? historial.map(tarjetaCita).join('')
    : vacio('history', 'Aún no hay historial', 'Tus citas pasadas y canceladas aparecerán aquí.', false);
  lucide.createIcons();
}

function minutos(hora) {
  const s = String(hora || '').toLowerCase();
  let [h, m] = s.replace(/[^\d:]/g, '').split(':').map(Number);
  if (s.includes('pm') && h < 12) h += 12;
  if (s.includes('am') && h === 12) h = 0;
  return (h || 0) * 60 + (m || 0);
}

async function cancelarCita(id) {
  const c = citas.find(x => x.id === id);
  if (!c) return;
  const f = formatearFecha(c.fecha);
  const si = await confirmar('¿Cancelar esta cita?', `${c.servicio} · ${f.larga} a las ${formatearHora(c.hora)} El horario quedará libre para otra persona.`, 'Sí, cancelar');
  if (!si) return;
  const { ok, data } = await api(`/clientes/me/citas/${id}/cancelar`, { method: 'POST' });
  if (!ok) return avisar(data?.message || 'No se pudo cancelar la cita.', 'error');
  avisar('Tu cita fue cancelada.');
  await cargarCitas();
}

async function cargarCitas() {
  const { ok, data } = await api('/clientes/me/citas');
  if (!ok) return;
  citas = data || [];
  renderCitas();
}

async function cargarCuenta() {
  const { ok, data } = await api('/clientes/me');
  if (!ok) { if (!sesion) mostrarVista('auth'); return; }
  $('perfil-nombre').textContent = `Hola, ${String(data.nombre || '').split(' ')[0]} 👋`;
  $('perfil-tel').textContent = separarTelefono(data.telefono);
  $('perfil-inicial').textContent = String(data.nombre || '?').trim().charAt(0).toUpperCase();
  guardarSesion({ ...sesion, nombre: data.nombre, telefono: data.telefono });
  mostrarPestana('proximas');
  mostrarVista('cuenta');
  await cargarCitas();
}

// ---------- Inicio ----------
async function iniciar() {
  llenarPaises('login-pais');
  llenarPaises('reg-pais');
  const linkReservar = `/index.html?b=${encodeURIComponent(slug)}`;
  ['link-volver', 'btn-nueva-cita', 'link-reservar-sin-cuenta'].forEach(id => { $(id).href = linkReservar; });

  try {
    const res = await fetch(`/api/public/barberia/${encodeURIComponent(slug)}`);
    if (res.ok) {
      const b = await res.json();
      if (window.aplicarTemaBarberia) aplicarTemaBarberia(b);
      $('header-barberia').textContent = b.nombre;
      $('auth-barberia').textContent = b.nombre;
      document.title = `Mi cuenta · ${b.nombre}`;
    } else {
      $('header-barberia').textContent = 'Barbería no encontrada';
    }
  } catch (e) {}

  sesion = leerSesion();
  if (sesion) await cargarCuenta();
  else {
    mostrarVista('auth');
    // Viene de "Crear mi cuenta" en la página de reservas: abrir el registro con sus datos ya escritos
    if (new URLSearchParams(location.search).get('registro') === '1') {
      mostrarFormulario('registro');
      try {
        const datos = JSON.parse(sessionStorage.getItem('bf_prellenar_registro') || 'null');
        sessionStorage.removeItem('bf_prellenar_registro');
        if (datos?.nombre) $('reg-nombre').value = datos.nombre;
        if (datos?.pais && [...$('reg-pais').options].some(o => o.value === datos.pais)) $('reg-pais').value = datos.pais;
        if (datos?.telefono) $('reg-tel').value = datos.telefono;
        (datos?.nombre && datos?.telefono ? $('reg-genero') : $('reg-nombre')).focus();
      } catch (e) {}
    }
  }
}

window.addEventListener('DOMContentLoaded', iniciar);
