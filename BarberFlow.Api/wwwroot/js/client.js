// BarberFlow Pro - Página pública de reservas de una barbería
const slugUrl = (new URLSearchParams(location.search).get('b') || 'barberia-jr').toLowerCase();
const CLAVE_SESION = `bf_cliente_session_${slugUrl}`;
const PAISES = [
  ['+57', '🇨🇴'], ['+1', '🇺🇸'], ['+34', '🇪🇸'], ['+52', '🇲🇽'], ['+54', '🇦🇷'],
  ['+56', '🇨🇱'], ['+51', '🇵🇪'], ['+58', '🇻🇪'], ['+593', '🇪🇨'], ['+507', '🇵🇦']
];
const DEFAULT_AVATAR = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%2364748B'><rect width='24' height='24' fill='%231F2937'/><circle cx='12' cy='9' r='4'/><path d='M4 21c0-4 4-6 8-6s8 2 8 6'/></svg>";
const DIAS_CORTOS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const DIAS_LARGOS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const DIAS_A_MOSTRAR = 30;

let barberia = null;
let todosLosServicios = [];
let categoriaActiva = '';
let textoBusqueda = '';
let clienteSesion = null;
// Los enlaces (?calificar= / ?reagendar=) traen el token público de la cita, nunca su id
let citaTokenCalificar = null;
let citaTokenReagendar = null;
let citaReagendarInfo = null; // fecha y hora de la cita que se reagenda (su turno queda libre para elegir)

const reservaActual = { servicioId: null, barberoId: null, fechaSeleccionada: null, horaSeleccionada: null, total: 0 };

// ================== Utilidades ==================
function $(id) { return document.getElementById(id); }
function mostrar(id, visible) { const el = $(id); if (el) el.classList.toggle('oculto', !visible); }

function escapeHtml(valor) {
  return String(valor ?? '').replace(/[&<>"'`]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[ch]));
}

function formatearPrecio(valor) {
  return `$ ${Number(valor || 0).toLocaleString('es-CO')}`;
}

function formatearDuracion(min) {
  if (!min) return '';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

// Fecha y hora actuales en Colombia (la barbería trabaja en esa zona horaria, sin importar dónde esté el cliente)
function ahoraBogota() {
  const partes = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(new Date()).map(p => [p.type, p.value]));
  const hora = Number(partes.hour) % 24;
  const iso = `${partes.year}-${partes.month}-${partes.day}`;
  return { iso, minutos: hora * 60 + Number(partes.minute), dow: diaSemana(iso) };
}

function isoAUtc(iso) { const [a, m, d] = iso.split('-').map(Number); return Date.UTC(a, m - 1, d, 12); }
function diaSemana(iso) { return new Date(isoAUtc(iso)).getUTCDay(); }
function sumarDias(iso, n) { return new Date(isoAUtc(iso) + n * 86400000).toISOString().slice(0, 10); }
function diasEntre(desde, hasta) { return Math.round((isoAUtc(hasta) - isoAUtc(desde)) / 86400000); }

function fechaLegible(iso) {
  if (!iso) return '';
  return new Date(isoAUtc(iso)).toLocaleDateString('es-CO', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' });
}

function capitalizar(texto) { return texto ? texto.charAt(0).toUpperCase() + texto.slice(1) : texto; }

// "04:30pm", "4:30 PM" o "16:30" -> minutos desde medianoche
function convertirHoraAMinutos(horaStr) {
  const t = String(horaStr || '').toLowerCase().trim();
  const m = t.match(/(\d{1,2}):(\d{2})/);
  if (!m) return 0;
  let h = Number(m[1]);
  if (t.includes('pm') && h < 12) h += 12;
  if (t.includes('am') && h === 12) h = 0;
  return h * 60 + Number(m[2]);
}

// Para mostrar: "6:50 p. m."
function minutosATexto(min) {
  const h = Math.floor(min / 60), m = min % 60;
  // Espacios no separables para que "7:10 p. m." nunca se parta en dos líneas
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'a. m.' : 'p. m.'}`;
}

// Valor que se guarda en la cita (formato histórico de la app): "06:50pm"
function minutosAValor(min) {
  const h = Math.floor(min / 60), m = min % 60;
  return `${String(h % 12 || 12).padStart(2, '0')}:${String(m).padStart(2, '0')}${h < 12 ? 'am' : 'pm'}`;
}

function servicioActual() { return todosLosServicios.find(s => s.id === reservaActual.servicioId) || null; }

function diasLaborales() {
  return String(barberia.diasLaborales || '1,2,3,4,5,6').split(',').map(d => Number(d.trim()));
}

function esDiaLaborable(iso) {
  const bloqueado = (barberia.bloqueos || []).some(b => b.fecha === iso && (!b.hora || b.hora === 'TODO_EL_DIA'));
  return diasLaborales().includes(diaSemana(iso)) && !bloqueado;
}

// ================== Carga inicial ==================
async function initClient() {
  llenarPaises();
  cargarSesionCliente();
  try {
    const res = await fetch(`/api/public/barberia/${encodeURIComponent(slugUrl)}`);
    if (!res.ok) return mostrarBarberiaNoEncontrada();
    barberia = await res.json();
  } catch (err) {
    console.error('Error cargando la barbería:', err);
    return mostrarBarberiaNoEncontrada('No pudimos conectar con el servidor. Revisa tu conexión e intenta de nuevo.');
  }

  todosLosServicios = barberia.servicios || [];
  const linkCuenta = `/cuenta.html?b=${encodeURIComponent(barberia.slug)}`;
  ['btn-portal-cliente', 'link-exito-mis-citas'].forEach(id => { const el = $(id); if (el) el.href = linkCuenta; });

  renderEncabezado();
  renderCategoriasYServicios();
  configurarSelectorBarbero();
  numerarPasos();
  renderCalendario();
  renderOpiniones();
  actualizarResumen();
  await verificarParametrosUrl();
  lucide.createIcons();
}

function mostrarBarberiaNoEncontrada(texto) {
  $('header-nombre').textContent = 'BarberFlow';
  document.querySelector('main').innerHTML = `
    <div class="tarjeta p-8 text-center aparecer">
      <div class="w-14 h-14 rounded-2xl bg-gray-800 flex items-center justify-center mx-auto"><i data-lucide="store" class="w-7 h-7 text-gray-500"></i></div>
      <h1 class="text-xl font-extrabold text-white mt-4">Barbería no encontrada</h1>
      <p class="text-sm text-gray-400 mt-2">${escapeHtml(texto || 'Revisa el enlace que te compartió tu barbería.')}</p>
    </div>`;
  lucide.createIcons();
}

function llenarPaises() {
  $('cliente-pais').innerHTML = PAISES.map(([cod, flag]) => `<option value="${cod}">${flag} ${cod}</option>`).join('');
}

// ================== Encabezado de la barbería ==================
function estadoApertura() {
  const ahora = ahoraBogota();
  const abre = convertirHoraAMinutos(barberia.horaApertura || '09:00');
  const cierra = convertirHoraAMinutos(barberia.horaCierre || '20:00');

  if (esDiaLaborable(ahora.iso) && ahora.minutos >= abre && ahora.minutos < cierra) {
    return { abierto: true, texto: `Abierto · cierra a las ${minutosATexto(cierra)}` };
  }
  if (esDiaLaborable(ahora.iso) && ahora.minutos < abre) {
    return { abierto: false, texto: `Cerrado · abre hoy a las ${minutosATexto(abre)}` };
  }
  for (let i = 1; i <= 14; i++) {
    const dia = sumarDias(ahora.iso, i);
    if (esDiaLaborable(dia)) {
      const cuando = i === 1 ? 'mañana' : `el ${DIAS_LARGOS[diaSemana(dia)]}`;
      return { abierto: false, texto: `Cerrado · abre ${cuando} a las ${minutosATexto(abre)}` };
    }
  }
  return { abierto: false, texto: 'Cerrado' };
}

function renderEncabezado() {
  if (window.aplicarTemaBarberia) aplicarTemaBarberia(barberia);
  document.title = `Reservar cita · ${barberia.nombre}`;
  $('header-nombre').textContent = barberia.nombre;
  $('barber-name').textContent = barberia.nombre;
  $('barber-desc').textContent = barberia.descripcion || '';

  const logo = barberia.logoUrl || DEFAULT_AVATAR;
  ['barber-logo', 'header-logo'].forEach(id => {
    const img = $(id);
    img.src = logo;
    img.onerror = () => { img.src = DEFAULT_AVATAR; };
  });

  const estado = estadoApertura();
  $('estado-apertura').innerHTML = `<span class="w-2 h-2 rounded-full ${estado.abierto ? 'bg-emerald-400 animate-pulse' : 'bg-gray-500'}"></span>
    <span class="${estado.abierto ? 'text-emerald-300' : 'text-gray-400'}">${escapeHtml(estado.texto)}</span>`;

  $('barber-stars').textContent = barberia.totalValoraciones ? Number(barberia.calificacion || 5).toFixed(1) : '5.0';
  $('barber-reviews').textContent = `(${barberia.totalValoraciones || 0} opiniones)`;

  if (barberia.direccion) {
    $('barber-address').querySelector('span').textContent = barberia.direccion;
    mostrar('barber-address', true);
    $('link-mapa').href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${barberia.nombre} ${barberia.direccion}`)}`;
    mostrar('link-mapa', true);
  }
  if (barberia.telefonoWhatsApp) {
    $('link-whatsapp-direct').href = `https://wa.me/${barberia.telefonoWhatsApp.replace(/\D/g, '')}`;
    mostrar('link-whatsapp-direct', true);
  }
}

function abrirModalImagenGrande(src, titulo, subtitulo = '') {
  $('img-grande-src').src = src;
  $('img-grande-titulo').textContent = titulo || '';
  $('img-grande-subtitulo').textContent = subtitulo || '';
  mostrar('modal-foto-grande', true);
}

function cerrarModalFotoGrande() { mostrar('modal-foto-grande', false); }

window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  cerrarModalFotoGrande();
  cerrarModalValoracion();
  if (!$('success-modal').classList.contains('oculto')) cerrarModal();
});

// ================== Paso 1: servicios ==================
function obtenerIconoCategoria(nombreCat) {
  const cat = (nombreCat || '').toLowerCase();
  if (cat.includes('uña') || cat.includes('manic') || cat.includes('pedic')) return '💅';
  if (cat.includes('facial') || cat.includes('limpieza') || cat.includes('piel') || cat.includes('exfolia')) return '✨';
  if (cat.includes('barba') || cat.includes('afeitado')) return '🧔';
  if (cat.includes('combo') || cat.includes('pack') || cat.includes('promo')) return '👑';
  if (cat.includes('ceja')) return '👁️';
  if (cat.includes('masaje') || cat.includes('spa')) return '💆';
  if (cat.includes('tinte') || cat.includes('color')) return '🎨';
  return '✂️';
}

function categoriaDe(s) { return (s.categoria && s.categoria.trim()) || 'Servicios'; }

function renderCategoriasYServicios() {
  const categorias = [...new Set(todosLosServicios.map(categoriaDe))];
  if (!categorias.includes(categoriaActiva)) categoriaActiva = categorias[0] || '';

  const cont = $('categorias-container');
  // Categorías como íconos circulares con el nombre debajo
  cont.innerHTML = categorias.length > 1 ? categorias.map(cat => {
    const activa = cat === categoriaActiva && !textoBusqueda;
    return `<button type="button" role="tab" aria-selected="${activa}" data-cat="${escapeHtml(cat)}"
      class="flex flex-col items-center gap-1.5 flex-shrink-0 w-20 focus:outline-none transition-transform active:scale-95">
      <span class="w-14 h-14 sm:w-16 sm:h-16 rounded-full flex items-center justify-center text-2xl transition-all ${activa
        ? 'bg-blue-600 ring-4 ring-blue-500/30 scale-105 shadow-lg shadow-blue-600/25'
        : 'bg-gray-800 hover:bg-gray-700'}">${obtenerIconoCategoria(cat)}</span>
      <span class="text-xs sm:text-sm font-semibold text-center leading-tight ${activa ? 'text-blue-400 font-extrabold' : 'text-gray-400'}">${escapeHtml(cat)}</span>
    </button>`;
  }).join('') : '';
  $('titulo-categoria-activa').textContent = textoBusqueda ? 'Resultados de búsqueda' : (categorias.length > 1 ? categoriaActiva : '');
  cont.querySelectorAll('button').forEach(b => b.onclick = () => { categoriaActiva = b.dataset.cat; textoBusqueda = ''; $('input-buscar-servicio').value = ''; renderCategoriasYServicios(); });

  filtrarYRenderizarTarjetas();
}

function filtrarServiciosPorTexto(texto) {
  textoBusqueda = texto.toLowerCase().trim();
  renderCategoriasYServicios();
}

function filtrarYRenderizarTarjetas() {
  const cont = $('services-cards-grid');
  const filtrados = textoBusqueda
    ? todosLosServicios.filter(s => [s.nombre, s.descripcion, s.categoria].some(v => (v || '').toLowerCase().includes(textoBusqueda)))
    : todosLosServicios.filter(s => categoriaDe(s) === categoriaActiva);

  if (!todosLosServicios.length) {
    cont.innerHTML = `<p class="col-span-full py-8 text-center text-sm text-gray-500">Esta barbería aún no ha publicado sus servicios.</p>`;
    return;
  }
  if (!filtrados.length) {
    cont.innerHTML = `<p class="col-span-full py-8 text-center text-sm text-gray-500">No encontramos servicios con “${escapeHtml(textoBusqueda)}”.</p>`;
    return;
  }

  cont.innerHTML = filtrados.map(s => {
    const elegido = reservaActual.servicioId === s.id;
    return `
      <button type="button" data-id="${s.id}" aria-pressed="${elegido}"
        class="text-left p-4 rounded-2xl border transition flex flex-col gap-2 ${elegido
          ? 'bg-blue-600/15 border-blue-500 ring-1 ring-blue-500'
          : 'bg-gray-950/50 border-gray-800 hover:border-gray-700'}">
        <div class="flex items-start justify-between gap-3 w-full">
          <div class="min-w-0">
            ${textoBusqueda ? `<span class="text-[10px] font-bold uppercase tracking-wide text-blue-300/80">${escapeHtml(categoriaDe(s))}</span>` : ''}
            <h3 class="font-bold text-white text-sm leading-snug">${escapeHtml(s.nombre)}</h3>
          </div>
          <span class="w-6 h-6 rounded-full border flex items-center justify-center flex-shrink-0 ${elegido ? 'bg-blue-600 border-blue-500' : 'border-gray-600'}">
            ${elegido ? '<i data-lucide="check" class="w-3.5 h-3.5 text-white"></i>' : ''}
          </span>
        </div>
        ${s.descripcion ? `<p class="text-xs text-gray-400 line-clamp-2">${escapeHtml(s.descripcion)}</p>` : ''}
        <div class="flex items-center justify-between w-full pt-1">
          <span class="text-xs text-gray-400 flex items-center gap-1"><i data-lucide="clock" class="w-3.5 h-3.5"></i> ${formatearDuracion(s.duracionMinutos)}</span>
          <span class="font-extrabold text-white text-sm">${formatearPrecio(s.precio)}</span>
        </div>
      </button>`;
  }).join('');

  cont.querySelectorAll('button[data-id]').forEach(b => b.onclick = () => {
    const s = todosLosServicios.find(x => x.id === Number(b.dataset.id));
    if (s) seleccionarServicio(s, true);
  });
  lucide.createIcons();
}

function seleccionarServicio(s, desplazar) {
  reservaActual.servicioId = s.id;
  reservaActual.total = s.precio;
  filtrarYRenderizarTarjetas();
  renderCalendario(true);
  actualizarResumen();
  if (desplazar) {
    const siguiente = !$('seccion-selector-barbero').classList.contains('oculto') ? 'seccion-selector-barbero' : 'seccion-paso-calendario';
    setTimeout(() => $(siguiente).scrollIntoView({ behavior: 'smooth', block: 'start' }), 150);
  }
}

// ================== Paso 2: profesional ==================
function configurarSelectorBarbero() {
  const miembros = barberia.miembros || [];
  if (!barberia.mostrarSelectorBarbero || miembros.length <= 1) {
    reservaActual.barberoId = miembros.length === 1 ? miembros[0].id : null;
    mostrar('seccion-selector-barbero', false);
    mostrar('resumen-box-barbero', false);
    return;
  }
  mostrar('seccion-selector-barbero', true);
  mostrar('resumen-box-barbero', true);
  renderBarberos();
}

function renderBarberos() {
  const lista = [{ id: null, nombre: 'Cualquiera', rol: 'El primero libre', fotoUrl: null }, ...(barberia.miembros || [])];
  $('barbers-container').innerHTML = lista.map(b => {
    const activo = reservaActual.barberoId === b.id;
    // Tocar la foto la abre en grande (y también elige a ese barbero)
    const fotoReal = b.fotoUrl && !b.fotoUrl.startsWith('data:image/svg');
    const avatar = `<img src="${escapeHtml(b.fotoUrl || '')}" alt="Foto de ${escapeHtml(b.nombre)}" loading="lazy" class="w-14 h-14 rounded-full object-cover bg-gray-800" onerror="this.onerror=null;this.src=DEFAULT_AVATAR">`;
    const foto = fotoReal
      ? `<span class="relative block w-14 h-14 mx-auto" data-ver-foto title="Ver foto">
          ${avatar}
          <span class="absolute -bottom-0.5 -right-0.5 w-5 h-5 rounded-full bg-gray-900 border border-gray-700 flex items-center justify-center"><i data-lucide="zoom-in" class="w-3 h-3 text-gray-300"></i></span>
        </span>`
      : b.fotoUrl ? `<span class="block w-14 h-14 mx-auto">${avatar}</span>`
      : `<div class="w-14 h-14 rounded-full bg-gray-800 mx-auto flex items-center justify-center"><i data-lucide="users" class="w-6 h-6 text-gray-400"></i></div>`;
    return `<button type="button" data-id="${b.id ?? ''}" aria-pressed="${activo}"
      class="w-28 flex-shrink-0 p-3 rounded-2xl border text-center transition ${activo ? 'bg-blue-600/15 border-blue-500 ring-1 ring-blue-500' : 'bg-gray-950/50 border-gray-800 hover:border-gray-700'}">
      ${foto}
      <div class="font-bold text-xs text-white truncate mt-2">${escapeHtml(b.nombre)}</div>
      <div class="text-[10px] text-gray-500 truncate">${escapeHtml(b.rol || '')}</div>
    </button>`;
  }).join('');
  $('barbers-container').querySelectorAll('button').forEach(btn => btn.onclick = (e) => {
    reservaActual.barberoId = btn.dataset.id ? Number(btn.dataset.id) : null;
    const b = lista.find(x => (x.id ?? '') === (reservaActual.barberoId ?? ''));
    if (b?.fotoUrl && e.target.closest('[data-ver-foto]')) abrirModalImagenGrande(b.fotoUrl, b.nombre, b.rol);
    $('resumen-barbero').textContent = b ? b.nombre : 'Cualquiera';
    renderBarberos();
    renderCalendario(true);
  });
  lucide.createIcons();
}

// ================== Paso 3: día y hora ==================
// Turnos libres de un día para el servicio elegido.
// Hoy empiezan en "ahora + anticipación" (redondeado a 10 min), así no se pierde un cliente si el puesto está libre.
// ¿La barbería trabaja con varios barberos, cada uno con su agenda?
function hayVariosBarberos() {
  return !!barberia.mostrarSelectorBarbero && (barberia.miembros || []).length > 1;
}

// Turnos libres del día. Con varios barberos y "Cualquiera": los turnos en los que al menos uno está libre.
function generarTurnos(iso) {
  if (hayVariosBarberos() && reservaActual.barberoId == null) {
    const todos = new Set();
    barberia.miembros.forEach(m => generarTurnosDe(iso, m.id).forEach(t => todos.add(t)));
    return [...todos].sort((a, b) => a - b);
  }
  return generarTurnosDe(iso, hayVariosBarberos() ? reservaActual.barberoId : null);
}

// barberoId = null: una sola agenda para toda la barbería
function generarTurnosDe(iso, barberoId) {
  const serv = servicioActual();
  if (!serv || !esDiaLaborable(iso)) return [];

  const ahora = ahoraBogota();
  const diferenciaDias = diasEntre(ahora.iso, iso);
  if (diferenciaDias < 0) return [];

  const duracion = serv.duracionMinutos || barberia.intervaloMinutos || 40;
  const intervalo = barberia.intervaloMinutos || 40;
  const apertura = convertirHoraAMinutos(barberia.horaApertura || '09:00');
  const cierre = convertirHoraAMinutos(barberia.horaCierre || '20:00');
  const anticipacion = barberia.minutosAnticipacion ?? 30;
  const minimoDelDia = ahora.minutos + anticipacion - diferenciaDias * 1440;

  const ocupados = (barberia.citasOcupadas || [])
    .filter(c => c.fecha === iso)
    .filter(c => barberoId == null || c.miembroEquipoId == null || c.miembroEquipoId === barberoId)
    .filter(c => !(citaReagendarInfo && c.fecha === citaReagendarInfo.fecha && convertirHoraAMinutos(c.hora) === convertirHoraAMinutos(citaReagendarInfo.hora)))
    .map(c => { const ini = convertirHoraAMinutos(c.hora); return { ini, fin: ini + (c.duracionMinutos || intervalo) }; });

  (barberia.bloqueos || []).filter(b => b.fecha === iso && b.hora && b.hora !== 'TODO_EL_DIA').forEach(b => {
    if (b.hora.includes('-')) {
      const [desde, hasta] = b.hora.split('-');
      ocupados.push({ ini: convertirHoraAMinutos(desde), fin: convertirHoraAMinutos(hasta) });
    } else {
      const ini = convertirHoraAMinutos(b.hora);
      ocupados.push({ ini, fin: ini + intervalo });
    }
  });

  const turnos = [];
  let cursor = Math.max(apertura, Math.ceil(minimoDelDia / 10) * 10);
  let vueltas = 0;
  while (cursor + duracion <= cierre + 15 && cursor < cierre && vueltas++ < 500) {
    const choque = ocupados.find(o => cursor < o.fin && cursor + duracion > o.ini);
    if (!choque) {
      turnos.push(cursor);
      cursor += intervalo;
    } else {
      // Saltar al final del turno ocupado + 10 min de alistamiento
      cursor = Math.max(cursor + 10, Math.ceil((choque.fin + 10) / 10) * 10);
    }
  }
  return turnos;
}

function primerDiaConTurnos() {
  const hoy = ahoraBogota().iso;
  for (let i = 0; i < DIAS_A_MOSTRAR; i++) {
    const dia = sumarDias(hoy, i);
    if (generarTurnos(dia).length) return dia;
  }
  return null;
}

function renderCalendario(reubicar) {
  const hoy = ahoraBogota().iso;
  const hayServicio = !!servicioActual();

  // Si el día elegido ya no tiene turnos (o aún no hay día), pasar al primero disponible
  if (hayServicio && (reubicar || !reservaActual.fechaSeleccionada) &&
      (!reservaActual.fechaSeleccionada || !generarTurnos(reservaActual.fechaSeleccionada).length)) {
    reservaActual.fechaSeleccionada = primerDiaConTurnos();
    reservaActual.horaSeleccionada = null;
  }

  const tira = $('tira-dias');
  let html = '';
  for (let i = 0; i < DIAS_A_MOSTRAR; i++) {
    const iso = sumarDias(hoy, i);
    const laborable = esDiaLaborable(iso);
    const turnos = hayServicio && laborable ? generarTurnos(iso).length : null;
    const disponible = laborable && (turnos === null || turnos > 0);
    const elegido = reservaActual.fechaSeleccionada === iso;
    const etiqueta = i === 0 ? 'hoy' : i === 1 ? 'mañ' : DIAS_CORTOS[diaSemana(iso)];
    const pie = !laborable ? 'Cerrado' : turnos === 0 ? 'Lleno' : '';
    html += `<button type="button" data-fecha="${iso}" ${disponible ? '' : 'disabled'}
      class="w-14 flex-shrink-0 py-2 rounded-2xl border text-center transition ${elegido
        ? 'bg-blue-600 border-blue-500 text-white shadow-lg shadow-blue-600/25'
        : disponible ? 'bg-gray-950/60 border-gray-800 text-gray-200 hover:border-gray-600' : 'bg-transparent border-gray-800/50 text-gray-600 cursor-not-allowed'}">
      <span class="block text-[10px] font-bold uppercase ${elegido ? 'text-blue-100' : 'text-gray-500'}">${etiqueta}</span>
      <span class="block text-lg font-extrabold leading-tight">${Number(iso.slice(8))}</span>
      <span class="block text-[9px] font-semibold h-3 ${elegido ? 'text-blue-100' : 'text-gray-600'}">${pie}</span>
    </button>`;
  }
  tira.innerHTML = html;
  tira.querySelectorAll('button:not([disabled])').forEach(b => b.onclick = () => seleccionarDiaCalendario(b.dataset.fecha));

  const referencia = reservaActual.fechaSeleccionada || hoy;
  $('mes-anio-label').textContent = capitalizar(new Date(isoAUtc(referencia)).toLocaleDateString('es-CO', { timeZone: 'UTC', month: 'long', year: 'numeric' }).replace(' de ', ' '));

  const activo = tira.querySelector(`[data-fecha="${reservaActual.fechaSeleccionada}"]`);
  if (activo) activo.scrollIntoView({ block: 'nearest', inline: 'center' });

  renderAvisosCierre(hoy);
  renderHorariosDisponibles();
}

// Días que la barbería cerró a propósito (festivo, vacaciones…), con el motivo que escribió el barbero
function renderAvisosCierre(hoy) {
  const limite = sumarDias(hoy, 14);
  const cierres = (barberia.bloqueos || [])
    .filter(b => (!b.hora || b.hora === 'TODO_EL_DIA') && b.fecha >= hoy && b.fecha <= limite)
    .sort((a, b) => a.fecha.localeCompare(b.fecha));
  $('avisos-cierre').innerHTML = cierres.map(b => `
    <p class="text-xs text-amber-200/90 bg-amber-500/10 border border-amber-500/20 rounded-xl px-3 py-2 flex items-start gap-2">
      <i data-lucide="calendar-x" class="w-3.5 h-3.5 mt-0.5 flex-shrink-0"></i>
      <span><strong class="text-amber-100">${escapeHtml(capitalizar(fechaLegible(b.fecha)))}:</strong> cerrado${b.motivo ? ` por ${escapeHtml(b.motivo.toLowerCase())}` : ''}</span>
    </p>`).join('');
}

// Descansos de un día con su motivo (ej: "Almuerzo · 12:30 – 2:00 p. m.")
function descansosDelDia(iso) {
  return (barberia.bloqueos || [])
    .filter(b => b.fecha === iso && b.hora && b.hora !== 'TODO_EL_DIA')
    .map(b => {
      const [desde, hasta] = b.hora.includes('-') ? b.hora.split('-') : [b.hora, null];
      const ini = convertirHoraAMinutos(desde);
      const fin = hasta ? convertirHoraAMinutos(hasta) : ini + (barberia.intervaloMinutos || 40);
      return { ini, texto: `${b.motivo || 'Descanso'} · ${minutosATexto(ini)} – ${minutosATexto(fin)}` };
    })
    .sort((a, b) => a.ini - b.ini);
}

function desplazarDias(direccion) {
  const tira = $('tira-dias');
  tira.scrollBy({ left: direccion * tira.clientWidth * 0.8, behavior: 'smooth' });
}

function seleccionarDiaCalendario(iso) {
  reservaActual.fechaSeleccionada = iso;
  reservaActual.horaSeleccionada = null;
  renderCalendario();
  actualizarResumen();
}

function renderHorariosDisponibles() {
  const cont = $('lista-horas-container');
  if (!servicioActual()) {
    cont.innerHTML = `<div class="py-6 text-center text-sm text-gray-500 rounded-2xl border border-dashed border-gray-800">Primero elige un servicio para ver los horarios.</div>`;
    return;
  }
  const iso = reservaActual.fechaSeleccionada;
  if (!iso) {
    cont.innerHTML = `<div class="py-6 text-center text-sm text-gray-500 rounded-2xl border border-dashed border-gray-800">No hay turnos disponibles en los próximos ${DIAS_A_MOSTRAR} días. Escríbele a la barbería por WhatsApp.</div>`;
    return;
  }

  const turnos = generarTurnos(iso);
  if (!turnos.length) {
    const esHoy = iso === ahoraBogota().iso;
    const siguiente = primerDiaConTurnos();
    cont.innerHTML = `<div class="py-6 px-4 text-center rounded-2xl border border-dashed border-gray-800">
      <p class="text-sm text-gray-300 font-semibold">${esHoy ? 'Ya no quedan turnos para hoy' : 'No hay turnos este día'}</p>
      ${descansosDelDia(iso).length ? `<p class="text-xs text-gray-500 mt-1">${descansosDelDia(iso).map(d => escapeHtml(d.texto)).join('; ')}</p>` : ''}
      ${siguiente ? `<button type="button" onclick="seleccionarDiaCalendario('${siguiente}')" class="mt-3 text-xs font-bold text-blue-400 hover:text-blue-300">Ver el ${escapeHtml(fechaLegible(siguiente))} →</button>` : ''}
    </div>`;
    return;
  }

  const grupos = [
    ['Mañana', 'sunrise', turnos.filter(t => t < 720)],
    ['Tarde', 'sun', turnos.filter(t => t >= 720 && t < 1080)],
    ['Noche', 'moon', turnos.filter(t => t >= 1080)]
  ].filter(g => g[2].length);

  cont.innerHTML = grupos.map(([nombre, icono, lista]) => `
    <div class="mb-4 last:mb-0">
      <p class="text-xs font-bold text-gray-500 uppercase tracking-wide mb-2 flex items-center gap-1.5"><i data-lucide="${icono}" class="w-3.5 h-3.5"></i> ${nombre}</p>
      <div class="grid grid-cols-3 sm:grid-cols-4 gap-2">
        ${lista.map(min => {
          const valor = minutosAValor(min);
          const activo = reservaActual.horaSeleccionada === valor;
          return `<button type="button" data-hora="${valor}" aria-pressed="${activo}"
            class="py-2.5 rounded-xl border text-sm font-bold transition ${activo
              ? 'bg-blue-600 border-blue-500 text-white shadow-lg shadow-blue-600/25'
              : 'bg-gray-950/60 border-gray-800 text-gray-200 hover:border-blue-500/60'}">${minutosATexto(min)}</button>`;
        }).join('')}
      </div>
    </div>`).join('');

  const descansos = descansosDelDia(iso);
  if (descansos.length) {
    cont.insertAdjacentHTML('beforeend', `<p class="mt-3 text-xs text-gray-500 flex items-start gap-1.5"><i data-lucide="coffee" class="w-3.5 h-3.5 mt-0.5 flex-shrink-0"></i>
      <span>Ese día el barbero no atiende en: ${descansos.map(d => escapeHtml(d.texto)).join('; ')}</span></p>`);
  }

  cont.querySelectorAll('button[data-hora]').forEach(b => b.onclick = () => seleccionarHora(b.dataset.hora));
  lucide.createIcons();
}

function seleccionarHora(valor) {
  reservaActual.horaSeleccionada = valor;
  renderHorariosDisponibles();
  actualizarResumen();
}

// ================== Resumen, pasos y barra inferior ==================
function numerarPasos() {
  const conBarbero = !$('seccion-selector-barbero').classList.contains('oculto');
  $('num-paso-barbero').dataset.num = '2';
  $('num-paso-fecha').dataset.num = conBarbero ? '3' : '2';
  $('num-paso-datos').dataset.num = conBarbero ? '4' : '3';
  $('num-paso-servicio').dataset.num = '1';
}

function marcarPaso(id, listo) {
  const el = $(id);
  el.classList.toggle('listo', listo);
  el.innerHTML = listo ? '<i data-lucide="check" class="w-4 h-4"></i>' : el.dataset.num;
}

function datosCompletos() {
  return $('cliente-nombre').value.trim().length >= 2 && $('cliente-telefono').value.replace(/\D/g, '').length >= 7;
}

function actualizarResumen() {
  const serv = servicioActual();
  const fecha = reservaActual.fechaSeleccionada, hora = reservaActual.horaSeleccionada;
  const textoCuando = fecha && hora ? capitalizar(`${fechaLegible(fecha)} · ${minutosATexto(convertirHoraAMinutos(hora))}`) : 'Sin elegir';

  $('resumen-servicio').textContent = serv ? `${serv.nombre} (${formatearDuracion(serv.duracionMinutos)})` : 'Sin elegir';
  $('resumen-fecha-hora').textContent = textoCuando;
  $('resumen-precio').textContent = formatearPrecio(serv ? serv.precio : 0);

  marcarPaso('num-paso-servicio', !!serv);
  marcarPaso('num-paso-barbero', !!serv);
  marcarPaso('num-paso-fecha', !!(fecha && hora));
  marcarPaso('num-paso-datos', !!(serv && fecha && hora && datosCompletos()));

  // Barra inferior
  mostrar('barra-resumen', !!serv);
  if (serv) {
    $('barra-titulo').textContent = `${serv.nombre} · ${formatearPrecio(serv.precio)}`;
    $('barra-detalle').textContent = fecha && hora ? textoCuando : 'Elige día y hora';
    $('barra-boton').textContent = !(fecha && hora) ? 'Elegir hora' : datosCompletos() ? 'Confirmar' : 'Continuar';
  }
  lucide.createIcons();
}

function avanzarPaso() {
  if (!servicioActual()) return $('seccion-paso-servicios').scrollIntoView({ behavior: 'smooth' });
  if (!reservaActual.horaSeleccionada) return $('seccion-paso-calendario').scrollIntoView({ behavior: 'smooth' });
  if (!datosCompletos()) {
    $('seccion-datos').scrollIntoView({ behavior: 'smooth' });
    setTimeout(() => (!$('cliente-nombre').value.trim() ? $('cliente-nombre') : $('cliente-telefono')).focus(), 400);
    return;
  }
  $('form-cliente-reserva').requestSubmit();
}

['cliente-nombre', 'cliente-telefono'].forEach(id => document.addEventListener('input', e => { if (e.target.id === id) actualizarResumen(); }));

function mostrarErrorReserva(texto) {
  $('error-reserva').textContent = texto;
  mostrar('error-reserva', !!texto);
  if (texto) $('seccion-datos').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ================== Confirmar ==================
async function confirmarReservaFinal(e) {
  e.preventDefault();
  mostrarErrorReserva('');
  const serv = servicioActual();
  const nombre = $('cliente-nombre').value.trim();
  const telefono = `${$('cliente-pais').value}${$('cliente-telefono').value.replace(/\D/g, '')}`;

  if (!serv) return mostrarErrorReserva('Elige primero el servicio que quieres reservar.');
  if (!reservaActual.fechaSeleccionada || !reservaActual.horaSeleccionada) return mostrarErrorReserva('Elige el día y la hora de tu cita.');

  const btn = $('btn-confirmar-final');
  btn.disabled = true;
  btn.querySelector('span').textContent = 'Reservando...';

  try {
    const res = await fetch('/api/public/citas', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        barberiaSlug: barberia.slug,
        servicioId: serv.id,
        miembroEquipoId: reservaActual.barberoId,
        nombreCliente: nombre,
        telefonoCliente: telefono,
        fecha: reservaActual.fechaSeleccionada,
        hora: reservaActual.horaSeleccionada,
        reagendarToken: citaTokenReagendar
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      mostrarErrorReserva(data.message || 'No pudimos reservar ese horario. Intenta con otro.');
      await refrescarDisponibilidad();
      return;
    }

    $('exito-titulo').textContent = citaTokenReagendar ? '¡Cita reagendada!' : '¡Cita reservada!';
    $('modal-servicio').textContent = (data.servicioNombre || serv.nombre) + (data.barberoNombre ? ` · con ${data.barberoNombre}` : '');
    $('modal-horario').textContent = capitalizar(`${fechaLegible(data.fecha)} · ${minutosATexto(convertirHoraAMinutos(data.hora))}`);
    $('modal-codigo').textContent = data.codigoReserva || '';
    mostrar('barra-resumen', false);
    mostrar('success-modal', true);
    lucide.createIcons();
    try { if (typeof confetti === 'function') confetti({ particleCount: 80, spread: 60, origin: { y: 0.6 } }); } catch (err) {}
  } catch (err) {
    console.error('Error al confirmar:', err);
    mostrarErrorReserva('No pudimos conectar con el servidor. Revisa tu conexión e intenta de nuevo.');
  } finally {
    btn.disabled = false;
    btn.querySelector('span').textContent = 'Confirmar cita';
  }
}

async function refrescarDisponibilidad() {
  try {
    const res = await fetch(`/api/public/barberia/${encodeURIComponent(barberia.slug)}`);
    if (!res.ok) return;
    const nueva = await res.json();
    barberia.citasOcupadas = nueva.citasOcupadas;
    barberia.bloqueos = nueva.bloqueos;
    if (reservaActual.horaSeleccionada && !generarTurnos(reservaActual.fechaSeleccionada).map(minutosAValor).includes(reservaActual.horaSeleccionada)) {
      reservaActual.horaSeleccionada = null;
    }
    renderCalendario();
    actualizarResumen();
  } catch (e) {}
}

function cerrarModal() {
  mostrar('success-modal', false);
  // Volver a la página limpia (sin ?reagendar= ni ?calificar=) para no repetir el flujo anterior
  window.location.href = `/index.html?b=${encodeURIComponent(barberia.slug)}`;
}

// ================== Enlaces especiales: reagendar y calificar ==================
async function verificarParametrosUrl() {
  const params = new URLSearchParams(location.search);

  const calificarToken = params.get('calificar');
  if (calificarToken) {
    try {
      const res = await fetch(`/api/public/cita-resena/${encodeURIComponent(calificarToken)}`);
      if (!res.ok) {
        avisar('El enlace para calificar no es válido o ya expiró.');
      } else {
        const info = await res.json();
        if (info.puedeCalificar) {
          citaTokenCalificar = calificarToken;
          $('val-nombre').value = info.nombreCliente || '';
          $('modal-valoracion-titulo').textContent = `¿Cómo te fue en ${info.barberiaNombre}?`;
          abrirModalValoracion();
        } else {
          avisar(info.motivoNoCalificable || 'Esta cita no se puede calificar.');
        }
      }
    } catch (e) { console.log('Error cargando cita para calificar:', e); }
  }

  const reagendarToken = params.get('reagendar');
  if (reagendarToken) {
    try {
      const res = await fetch(`/api/public/cita-resena/${encodeURIComponent(reagendarToken)}`);
      if (!res.ok) {
        avisar('El enlace para reagendar no es válido. Puedes reservar un turno nuevo abajo.');
        return;
      }
      const info = await res.json();
      if (info.estado === 'Cancelada') {
        avisar('Esta cita ya fue cancelada o reagendada. Puedes reservar un turno nuevo abajo.');
        return;
      }
      const serv = todosLosServicios.find(s => s.nombre.toLowerCase() === String(info.servicio).toLowerCase());
      if (!serv) return;
      citaTokenReagendar = reagendarToken;
      citaReagendarInfo = { fecha: info.fecha, hora: info.hora };
      $('reagendar-nombre-servicio').textContent = info.servicio;
      mostrar('banner-reagendar-aviso', true);
      mostrar('seccion-paso-servicios', false);
      if (info.nombreCliente && !$('cliente-nombre').value) $('cliente-nombre').value = info.nombreCliente;
      reservaActual.fechaSeleccionada = null;
      seleccionarServicio(serv, false);
      setTimeout(() => $('seccion-paso-calendario').scrollIntoView({ behavior: 'smooth', block: 'start' }), 300);
    } catch (e) {}
  }
}

// ================== Opiniones ==================
function renderOpiniones() {
  const opiniones = barberia.ultimasValoraciones || [];
  $('lista-opiniones-cards').innerHTML = opiniones.length ? opiniones.map(op => {
    const estrellas = Math.min(5, Math.max(1, Number(op.estrellas) || 5));
    return `<div class="p-4 rounded-2xl bg-gray-950/50 border border-gray-800">
      <div class="flex items-center justify-between gap-2">
        <span class="font-bold text-white text-sm truncate">${escapeHtml(op.nombreCliente || 'Cliente')}</span>
        <span class="text-amber-400 text-xs tracking-wider">${'★'.repeat(estrellas)}<span class="text-gray-700">${'★'.repeat(5 - estrellas)}</span></span>
      </div>
      ${op.comentario ? `<p class="text-sm text-gray-300 mt-1.5">“${escapeHtml(op.comentario)}”</p>` : ''}
      <p class="text-[11px] text-gray-600 mt-2">${escapeHtml(op.fecha || '')}</p>
    </div>`;
  }).join('') : `<p class="col-span-full text-sm text-gray-500 text-center py-4">Aún no hay opiniones. ¡Sé el primero en calificar!</p>`;
}

function abrirModalValoracion() {
  // Opinan clientes atendidos: con el enlace de su cita (bot) o con su cuenta
  const puedeOpinar = !!citaTokenCalificar || !!clienteSesion;
  mostrar('val-requiere-cuenta', !puedeOpinar);
  mostrar('form-valoracion', puedeOpinar);
  $('val-link-cuenta').href = `/cuenta.html?b=${encodeURIComponent(slugUrl)}`;
  if (!$('val-nombre').value && clienteSesion?.nombre) $('val-nombre').value = clienteSesion.nombre;
  mostrar('modal-valoracion', true);
  seleccionarEstrella(Number($('val-estrellas').value) || 5);
}

function cerrarModalValoracion() { mostrar('modal-valoracion', false); }

function seleccionarEstrella(num) {
  $('val-estrellas').value = num;
  $('label-estrellas-desc').textContent = ({ 1: 'Mala', 2: 'Regular', 3: 'Buena', 4: 'Muy buena', 5: 'Excelente' })[num];
  document.querySelectorAll('#selector-estrellas .estrella').forEach((b, i) => b.classList.toggle('activa', i < num));
}

async function enviarValoracionCliente(e) {
  e.preventDefault();
  const btn = $('btn-enviar-valoracion');
  btn.disabled = true;
  btn.textContent = 'Enviando...';
  const estrellas = Number($('val-estrellas').value) || 5;
  const comentario = $('val-comentario').value.trim();
  try {
    const res = citaTokenCalificar
      ? await fetch('/api/public/calificar-cita', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: citaTokenCalificar, estrellas, comentario }) })
      : await fetch('/api/public/valoraciones', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${clienteSesion?.token || ''}` }, body: JSON.stringify({ barberiaSlug: barberia.slug, nombreCliente: clienteSesion?.nombre || '', estrellas, comentario }) });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { mostrar('form-valoracion', false); mostrar('val-requiere-cuenta', true); return; }
    if (!res.ok) { avisar(data.message || 'No se pudo enviar tu opinión.'); return; }
    cerrarModalValoracion();
    $('val-comentario').value = '';
    const ref = await fetch(`/api/public/barberia/${encodeURIComponent(barberia.slug)}`);
    if (ref.ok) {
      const nueva = await ref.json();
      Object.assign(barberia, { ultimasValoraciones: nueva.ultimasValoraciones, totalValoraciones: nueva.totalValoraciones, calificacion: nueva.calificacion });
      renderEncabezado();
      renderOpiniones();
    }
  } catch (err) {
    avisar('No pudimos conectar con el servidor.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Publicar opinión';
  }
}

// ================== Sesión del cliente (gestionada en /cuenta.html) ==================
function separarIndicativoYNumero(telefono) {
  let limpio = String(telefono || '').replace(/[^\d+]/g, '');
  if (!limpio.startsWith('+')) limpio = `+${limpio}`;
  for (const [cod] of [...PAISES].sort((a, b) => b[0].length - a[0].length)) {
    if (limpio.startsWith(cod)) return { indicativo: cod, numero: limpio.slice(cod.length) };
  }
  return { indicativo: '+57', numero: limpio.replace(/^\+/, '') };
}

function cargarSesionCliente() {
  try {
    localStorage.removeItem('bf_cliente_session'); // formato anterior (compartido entre barberías)
    const datos = JSON.parse(localStorage.getItem(CLAVE_SESION) || 'null');
    if (!datos || !datos.token) return;
    clienteSesion = datos;
    $('txt-btn-cliente').textContent = `Hola, ${String(datos.nombre || '').split(' ')[0]}`;
    if (datos.nombre) $('cliente-nombre').value = datos.nombre;
    if (datos.telefono) {
      const t = separarIndicativoYNumero(datos.telefono);
      $('cliente-pais').value = t.indicativo;
      $('cliente-telefono').value = t.numero;
    }
  } catch (e) {}
}

window.addEventListener('DOMContentLoaded', initClient);
