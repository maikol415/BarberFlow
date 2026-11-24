// Ingreso y registro de barberos (login.html)
function $(id) { return document.getElementById(id); }

function cambiarTab(tab) {
  const login = tab === 'login';
  $('auth-error').classList.add('oculto');
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
    password: $('reg-pass').value
  }, $('btn-register'), 'Creando tu barbería...', 'Crear mi barbería');
}
