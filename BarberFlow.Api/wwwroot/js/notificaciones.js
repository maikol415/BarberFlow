// Notificaciones push del panel del barbero (por ahora solo Android / Chrome).
// Cada celular se suscribe por separado y elige qué avisos quiere: citas nuevas, cancelaciones y resumen de la mañana.
(function () {
  const $ = id => document.getElementById(id);
  const CLAVE_BANNER = 'bf_notif_banner_oculto';
  const esIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const soportado = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

  let suscripcion = null; // PushSubscription de este celular
  let prefs = null;       // preferencias guardadas en la API (null = no suscrito)
  let ocupado = false;

  function base64AUint8(b64) {
    const relleno = '='.repeat((4 - b64.length % 4) % 4);
    const bin = atob((b64 + relleno).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(bin, c => c.charCodeAt(0));
  }

  async function api(ruta, metodo = 'GET', cuerpo) {
    const res = await fetch('/api/admin/push' + ruta, {
      method: metodo,
      headers: getAuthHeaders(),
      body: cuerpo ? JSON.stringify(cuerpo) : undefined
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || 'No se pudo completar. Intenta de nuevo.');
    return data;
  }

  const registro = () => navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready);

  function nombreDispositivo() {
    const ua = navigator.userAgent;
    const modelo = (ua.match(/Android [\d.]+; ([^;)]+)/) || [])[1];
    return modelo ? `Android · ${modelo.trim()}` : (/android/i.test(ua) ? 'Android' : 'Navegador');
  }

  async function cargarEstado() {
    if (!soportado() || esIOS) return pintar();
    try {
      const reg = await registro();
      suscripcion = await reg.pushManager.getSubscription();
      prefs = suscripcion ? await api('/estado', 'POST', { endpoint: suscripcion.endpoint }) : null;
      if (prefs && !prefs.suscrito) {
        // El celular tiene permiso pero la API no lo conoce (ej. se borró): se vuelve a registrar
        prefs = await enviarSuscripcion(suscripcion);
      }
    } catch (err) {
      console.log('Notificaciones:', err.message);
    }
    pintar();
  }

  function enviarSuscripcion(s) {
    const j = s.toJSON();
    return api('/suscribir', 'POST', { endpoint: j.endpoint, p256dh: j.keys?.p256dh, auth: j.keys?.auth, dispositivo: nombreDispositivo() });
  }

  async function activar() {
    if (ocupado) return;
    if (esIOS || !soportado()) return avisar('Por ahora las notificaciones funcionan en Android con Google Chrome.', 'error');
    ocupado = true;
    pintar();
    try {
      const permiso = await Notification.requestPermission();
      if (permiso !== 'granted') {
        avisar(permiso === 'denied'
          ? 'Chrome tiene bloqueadas las notificaciones de esta página. Toca el candado junto a la dirección › Permisos › Notificaciones › Permitir.'
          : 'No se activaron las notificaciones.', 'error');
        return;
      }
      const reg = await registro();
      const { clavePublica } = await api('/clave');
      suscripcion = await reg.pushManager.getSubscription()
        || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64AUint8(clavePublica) });
      prefs = await enviarSuscripcion(suscripcion);
      avisar('¡Listo! Este celular recibirá los avisos de tu barbería.', 'ok');
      localStorage.setItem(CLAVE_BANNER, '1');
    } catch (err) {
      avisar(err.message || 'No se pudieron activar las notificaciones.', 'error');
    } finally {
      ocupado = false;
      pintar();
    }
  }

  async function desactivar() {
    if (ocupado || !suscripcion) return;
    ocupado = true;
    pintar();
    try {
      await api('/desuscribir', 'POST', { endpoint: suscripcion.endpoint }).catch(() => {});
      await suscripcion.unsubscribe().catch(() => {});
      suscripcion = null;
      prefs = null;
      avisar('Listo, este celular ya no recibirá avisos.', 'ok');
    } finally {
      ocupado = false;
      pintar();
    }
  }

  async function guardarPrefs() {
    if (!suscripcion || !prefs) return;
    const nuevas = {
      endpoint: suscripcion.endpoint,
      avisarNuevas: $('notif-nuevas').checked,
      avisarCancelaciones: $('notif-cancelaciones').checked,
      resumenMatutino: $('notif-resumen').checked,
      horaResumen: $('notif-hora-resumen').value
    };
    try {
      prefs = await api('/preferencias', 'PUT', nuevas);
      avisar('Guardado.', 'ok');
    } catch (err) {
      avisar(err.message, 'error');
    }
    pintar();
  }

  async function probar() {
    if (!suscripcion) return;
    const btn = $('notif-btn-probar');
    btn.disabled = true;
    try {
      const r = await api('/probar', 'POST', { endpoint: suscripcion.endpoint });
      avisar(r.message, 'ok');
    } catch (err) {
      avisar(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  }

  async function verResumen() {
    const caja = $('notif-vista-resumen');
    caja.textContent = 'Cargando...';
    try {
      const r = await api('/resumen-hoy');
      caja.innerHTML = r.titulo
        ? `<b class="text-gray-200">${escapeHtml(r.titulo)}</b><br>${escapeHtml(r.cuerpo)}`
        : escapeHtml(r.cuerpo);
    } catch (err) {
      caja.textContent = err.message;
    }
  }

  function ocultarBanner() {
    localStorage.setItem(CLAVE_BANNER, '1');
    $('tarjeta-notif')?.classList.add('hidden');
  }

  function pintar() {
    const activo = !!(suscripcion && prefs && prefs.suscrito);
    const bloqueado = soportado() && Notification.permission === 'denied';
    const noDisponible = esIOS || !soportado();

    // Invitación en la agenda: solo si se puede activar y no la cerró antes
    let bannerOculto = false;
    try { bannerOculto = localStorage.getItem(CLAVE_BANNER) === '1'; } catch (e) { /* sin almacenamiento */ }
    $('tarjeta-notif')?.classList.toggle('hidden', activo || bloqueado || noDisponible || bannerOculto);

    const estado = $('notif-estado');
    const btn = $('notif-btn-principal');
    if (!estado || !btn) return;
    estado.textContent = noDisponible
      ? 'Por ahora funcionan en celulares Android con Google Chrome.'
      : bloqueado
        ? 'Chrome las tiene bloqueadas para esta página. Toca el candado junto a la dirección › Permisos › Notificaciones › Permitir, y vuelve a entrar.'
        : activo
          ? '✅ Activadas. Elige qué avisos quieres recibir en este celular.'
          : 'Desactivadas. Actívalas para enterarte al instante de cada reserva.';
    btn.classList.toggle('hidden', noDisponible || bloqueado);
    btn.disabled = ocupado;
    btn.textContent = ocupado ? 'Un momento...' : activo ? 'Desactivar' : 'Activar';
    btn.className = `h-9 px-4 rounded-xl font-bold text-sm flex-shrink-0 ${noDisponible || bloqueado ? 'hidden' : ''} ${activo ? 'bg-gray-800 hover:bg-gray-700 text-gray-200' : 'bg-blue-600 hover:bg-blue-500 text-white'}`;
    btn.onclick = activo ? desactivar : activar;

    $('notif-opciones').classList.toggle('hidden', !activo);
    if (activo) {
      $('notif-nuevas').checked = prefs.avisarNuevas;
      $('notif-cancelaciones').checked = prefs.avisarCancelaciones;
      $('notif-resumen').checked = prefs.resumenMatutino;
      $('notif-hora-resumen').value = prefs.horaResumen || '07:00';
      $('notif-hora-resumen').disabled = !prefs.resumenMatutino;
    }
  }

  // Cuando llega un aviso con el panel abierto, se recarga la agenda
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', e => {
      if (e.data && e.data.tipo === 'push-recibido' && typeof cargarCitas === 'function') cargarCitas();
    });
  }

  window.NotificacionesBF = { activar, desactivar, guardarPrefs, probar, verResumen, ocultarBanner };
  window.addEventListener('DOMContentLoaded', cargarEstado);
})();
