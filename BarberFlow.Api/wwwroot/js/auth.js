function cambiarTab(tab) {
  const errDiv = document.getElementById('auth-error');
  errDiv.classList.add('hidden');

  if (tab === 'login') {
    document.getElementById('form-login').classList.remove('hidden');
    document.getElementById('form-register').classList.add('hidden');
    document.getElementById('tab-login').className = 'py-2 rounded-xl font-bold bg-blue-600 text-white transition shadow-md shadow-blue-500/20';
    document.getElementById('tab-register').className = 'py-2 rounded-xl font-medium text-gray-400 hover:text-white transition';
  } else {
    document.getElementById('form-login').classList.add('hidden');
    document.getElementById('form-register').classList.remove('hidden');
    document.getElementById('tab-register').className = 'py-2 rounded-xl font-bold bg-blue-600 text-white transition shadow-md shadow-blue-500/20';
    document.getElementById('tab-login').className = 'py-2 rounded-xl font-medium text-gray-400 hover:text-white transition';
  }
}

function togglePasswordVisibility(inputId, iconId) {
  const input = document.getElementById(inputId);
  const icon = document.getElementById(iconId);

  if (input.type === 'password') {
    input.type = 'text';
    icon.setAttribute('data-lucide', 'eye-off');
  } else {
    input.type = 'password';
    icon.setAttribute('data-lucide', 'eye');
  }
  lucide.createIcons();
}

function mostrarError(msg) {
  const errDiv = document.getElementById('auth-error');
  errDiv.innerText = msg;
  errDiv.classList.remove('hidden');
}

function validarEmail(email) {
  const re = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  if (!re.test(email)) return false;

  const dominio = email.split('@')[1].toLowerCase();
  if (dominio === 'mail.com' || dominio === 'gmal.com' || dominio === 'gmai.com') {
    return false;
  }
  return true;
}

async function hacerLogin(e) {
  e.preventDefault();
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-pass').value;
  const btn = document.getElementById('btn-login');

  if (!validarEmail(email)) {
    mostrarError('El correo parece mal escrito. Revisa que sea correcto (ej: tu_nombre@gmail.com).');
    return;
  }

  btn.disabled = true;
  btn.innerText = 'Verificando credenciales...';

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });

    const data = await res.json();
    if (!res.ok) {
      mostrarError(data.message || 'Correo o contraseña incorrectos.');
      btn.disabled = false;
      btn.innerText = 'Entrar al Panel';
      return;
    }

    localStorage.setItem('bf_token', data.token);
    localStorage.setItem('bf_user', JSON.stringify(data));
    window.location.href = '/admin.html';
  } catch (err) {
    mostrarError('No se pudo conectar con el servidor. Verifica que "dotnet run" esté activo en la terminal.');
    btn.disabled = false;
    btn.innerText = 'Entrar al Panel';
  }
}

async function hacerRegistro(e) {
  e.preventDefault();
  const email = document.getElementById('reg-email').value.trim();

  if (!validarEmail(email)) {
    mostrarError('El correo parece mal escrito. Por favor ingresa un correo válido (ej: @gmail.com, @hotmail.com).');
    return;
  }

  const payload = {
    nombreCompleto: document.getElementById('reg-name').value.trim(),
    nombreBarberia: document.getElementById('reg-barberia').value.trim(),
    telefonoWhatsApp: document.getElementById('reg-phone').value.trim(),
    email: email,
    password: document.getElementById('reg-pass').value
  };

  const btn = document.getElementById('btn-register');
  btn.disabled = true;
  btn.innerText = 'Creando barbería...';

  try {
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (!res.ok) {
      mostrarError(data.message || 'Error registrando la barbería.');
      btn.disabled = false;
      btn.innerText = 'Crear mi Barbería';
      return;
    }

    localStorage.setItem('bf_token', data.token);
    localStorage.setItem('bf_user', JSON.stringify(data));
    window.location.href = '/admin.html';
  } catch (err) {
    mostrarError('No se pudo conectar con el servidor. Verifica que "dotnet run" esté activo en la terminal.');
    btn.disabled = false;
    btn.innerText = 'Crear mi Barbería';
  }
}
