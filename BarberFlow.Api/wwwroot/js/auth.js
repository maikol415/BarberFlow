// Ingreso y registro de barberos (login.html)
function $(id) { return document.getElementById(id); }

function cambiarTab(tab) {
  const login = tab === 'login';
  $('auth-error').classList.add('oculto');
  $('form-recuperar').classList.add('oculto');
  $('form-login').classList.toggle('oculto', !login);
  $('form-register').classList.toggle('oculto', login);
  $('tab-login').className = `py-2 rounded-lg text-sm font-bold transition ${login ? 'tab-activa' : 'tab-inactiva'}`;
  $('tab-register').className = `py-2 rounded-lg text-sm font-bold transition ${login ? 'tab-inactiva' : 'tab-activa'}`;
}

function togglePasswordVisibility(inputId, boton) {
  const input = $(inputId);
  input.type = input.type === 'password' ? 'text' : 'password';
  boton.setAttribute('aria-label', input.type === 'password' ? 'Mostrar contraseña' : 'Ocultar contraseña');
  boton.innerHTML = `<i data-lucide="${input.type === 'password' ? 'eye' : 'eye-off'}" class="w-4 h-4"></i>`;
  lucide.createIcons();
}

function mostrarError(msg) {
  const err = $('auth-error');
  err.textContent = msg;
  err.classList.remove('oculto');
}

function validarEmail(email) {
  const re = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  if (!re.test(email)) return false;
  const dominio = email.split('@')[1].toLowerCase();
  return !['mail.com', 'gmal.com', 'gmai.com', 'hotmal.com', 'gmail.co'].includes(dominio);
}

function guardarSesionYEntrar(data) {
  localStorage.setItem('bf_token', data.token);
  localStorage.setItem('bf_user', JSON.stringify(data));
  window.location.href = '/admin.html';
}

async function enviar(url, payload, boton, textoCargando, textoNormal) {
  boton.disabled = true;
  boton.textContent = textoCargando;
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      mostrarError(data.message || 'No se pudo completar. Revisa los datos e inténtalo de nuevo.');
      return;
    }
    guardarSesionYEntrar(data);
  } catch (err) {
    mostrarError('No pudimos conectar con el servidor. Revisa tu internet e inténtalo de nuevo en un momento.');
  } finally {
    boton.disabled = false;
    boton.textContent = textoNormal;
  }
}

async function hacerLogin(e) {
  e.preventDefault();
  const email = $('login-email').value.trim();
  if (!validarEmail(email)) return mostrarError('El correo parece mal escrito. Revísalo (ej: tu_nombre@gmail.com).');
  await enviar('/api/auth/login', { email, password: $('login-pass').value }, $('btn-login'), 'Entrando...', 'Entrar');
}

// ----- Olvidé mi contraseña: código por WhatsApp -----
let pasoRecuperacion = 'correo';
let temporizadorReenvio = null;

function mostrarRecuperacion() {
  $('auth-error').classList.add('oculto');
  $('form-login').classList.add('oculto');
  $('form-recuperar').classList.remove('oculto');
  $('rec-email').value = $('login-email').value.trim();
  pasoRecuperacion = 'correo';
  $('rec-paso-correo').classList.remove('oculto');
  $('rec-paso-codigo').classList.add('oculto');
  $('btn-recuperar').textContent = 'Enviarme el código';
  $('rec-email').focus();
}

function volverAlLogin() {
  $('auth-error').classList.add('oculto');
  $('form-recuperar').classList.add('oculto');
  $('form-login').classList.remove('oculto');
}

// El botón "Reenviar código" se habilita a los 60 segundos
function esperarReenvio() {
  const boton = $('rec-reenviar');
  let quedan = 60;
  clearInterval(temporizadorReenvio);
  boton.disabled = true;
  boton.textContent = `Reenviar código en ${quedan} s`;
  temporizadorReenvio = setInterval(() => {
    quedan--;
    if (quedan <= 0) { clearInterval(temporizadorReenvio); boton.disabled = false; boton.textContent = 'Reenviar código'; }
    else boton.textContent = `Reenviar código en ${quedan} s`;
  }, 1000);
}

async function solicitarCodigoRecuperacion() {
  const email = $('rec-email').value.trim();
  if (!validarEmail(email)) { mostrarError('Escribe el correo con el que entras al panel.'); return false; }
  try {
    const res = await fetch('/api/auth/recuperar/solicitar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { mostrarError(data.message || 'No se pudo enviar el código. Inténtalo de nuevo.'); return false; }
    $('rec-mensaje').textContent = `${data.message} Si no te llega en unos minutos, revisa que el bot de WhatsApp de tu barbería esté conectado.`;
    return true;
  } catch (err) {
    mostrarError('No pudimos conectar con el servidor. Revisa tu internet e inténtalo de nuevo.');
    return false;
  }
}

async function enviarRecuperacion(e) {
  e.preventDefault();
  $('auth-error').classList.add('oculto');
  const boton = $('btn-recuperar');
  if (pasoRecuperacion === 'correo') {
    boton.disabled = true; boton.textContent = 'Enviando...';
    const ok = await solicitarCodigoRecuperacion();
    boton.disabled = false;
    if (!ok) { boton.textContent = 'Enviarme el código'; return; }
    pasoRecuperacion = 'codigo';
    $('rec-paso-correo').classList.add('oculto');
    $('rec-paso-codigo').classList.remove('oculto');
    boton.textContent = 'Cambiar contraseña';
    esperarReenvio();
    $('rec-codigo').focus();
    return;
  }
  const codigo = $('rec-codigo').value.replace(/\D/g, '');
  if (codigo.length !== 6) return mostrarError('Escribe los 6 dígitos del código que te llegó por WhatsApp.');
  if ($('rec-pass').value.length < 6) return mostrarError('La contraseña nueva debe tener al menos 6 caracteres.');
  // Si el código es correcto, queda con la sesión abierta y entra al panel
  await enviar('/api/auth/recuperar/confirmar', { email: $('rec-email').value.trim(), codigo, nuevaClave: $('rec-pass').value },
    boton, 'Cambiando...', 'Cambiar contraseña');
}

async function reenviarCodigoRecuperacion() {
  $('auth-error').classList.add('oculto');
  if (await solicitarCodigoRecuperacion()) esperarReenvio();
}

async function hacerRegistro(e) {
  e.preventDefault();
  const email = $('reg-email').value.trim();
  if (!validarEmail(email)) return mostrarError('El correo parece mal escrito. Revísalo (ej: tu_nombre@gmail.com).');
  const telefono = `${$('reg-pais').value}${$('reg-phone').value.replace(/\D/g, '')}`;
  await enviar('/api/auth/register', {
    nombreCompleto: $('reg-name').value.trim(),
    nombreBarberia: $('reg-barberia').value.trim(),
    telefonoWhatsApp: telefono,
    email,
    password: $('reg-pass').value,
    aceptaPrivacidad: $('reg-privacidad').checked
  }, $('btn-register'), 'Creando tu barbería...', 'Crear mi barbería');
}
