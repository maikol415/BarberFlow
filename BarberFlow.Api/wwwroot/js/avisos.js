// Avisos y diálogos con el estilo de la app (reemplazan alert / confirm / prompt del navegador).
//   avisar('Cambios guardados')                         -> aviso flotante que se cierra solo
//   if (!(await confirmar('¿Eliminar este servicio?'))) return;
//   const texto = await pedirTexto('Escribe ELIMINAR para confirmar');
(function () {
  const ESTILO = `
    .bf-avisos { position: fixed; left: 50%; bottom: 1.25rem; transform: translateX(-50%); z-index: 9999;
      display: flex; flex-direction: column; gap: .5rem; width: min(92vw, 26rem); pointer-events: none; }
    .bf-aviso { pointer-events: auto; display: flex; gap: .6rem; align-items: flex-start; padding: .8rem 1rem; border-radius: .9rem;
      font: 600 .875rem/1.35 'Plus Jakarta Sans', system-ui, sans-serif; color: #fff; box-shadow: 0 12px 30px rgba(0,0,0,.45);
      animation: bf-entrar .2s ease both; white-space: pre-line; }
    .bf-aviso.ok { background: #059669; }
    .bf-aviso.error { background: #DC2626; }
    .bf-aviso.info { background: #1F2937; border: 1px solid #374151; }
    .bf-aviso.saliendo { animation: bf-salir .2s ease both; }
    .bf-fondo { position: fixed; inset: 0; z-index: 9998; background: rgba(0,0,0,.72); backdrop-filter: blur(3px);
      display: flex; align-items: flex-end; justify-content: center; padding: 1rem; animation: bf-aparecer .15s ease both; }
    @media (min-width: 640px) { .bf-fondo { align-items: center; } }
    .bf-dialogo { width: 100%; max-width: 24rem; background: #111827; border: 1px solid #1F2937; border-radius: 1.5rem; padding: 1.4rem;
      font-family: 'Plus Jakarta Sans', system-ui, sans-serif; color: #F3F4F6; box-shadow: 0 20px 50px rgba(0,0,0,.5); animation: bf-entrar .2s ease both; }
    .bf-dialogo p { margin: 0; font-size: .95rem; line-height: 1.45; white-space: pre-line; }
    .bf-dialogo input { width: 100%; margin-top: .9rem; background: #030712; border: 1px solid #374151; border-radius: .75rem;
      padding: .7rem .9rem; color: #fff; font-size: .95rem; outline: none; box-sizing: border-box; }
    .bf-dialogo input:focus { border-color: #3B82F6; }
    .bf-botones { display: grid; grid-template-columns: 1fr 1fr; gap: .5rem; margin-top: 1.2rem; }
    .bf-botones button { padding: .7rem; border-radius: .8rem; border: 0; font: 700 .875rem 'Plus Jakarta Sans', system-ui, sans-serif; cursor: pointer; }
    .bf-cancelar { background: #1F2937; color: #E5E7EB; }
    .bf-aceptar { background: #2563EB; color: #fff; }
    .bf-aceptar.peligro { background: #DC2626; }
    @keyframes bf-entrar { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
    @keyframes bf-salir { to { opacity: 0; transform: translateY(8px); } }
    @keyframes bf-aparecer { from { opacity: 0; } to { opacity: 1; } }
  `;

  function asegurarEstilo() {
    if (document.getElementById('bf-avisos-estilo')) return;
    const s = document.createElement('style');
    s.id = 'bf-avisos-estilo';
    s.textContent = ESTILO;
    document.head.appendChild(s);
  }

  // Tipo según el texto: errores y advertencias en rojo, lo demás en verde
  function tipoDe(texto) {
    if (/operación cancelada|no se eliminó/i.test(texto)) return 'info';
    return /error|no se pudo|no pudimos|inválid|invalid|incorrect|falt|por favor|selecciona|no es válid|⚠️|❌/i.test(texto) ? 'error' : 'ok';
  }

  window.avisar = function (texto, tipo) {
    asegurarEstilo();
    let cont = document.querySelector('.bf-avisos');
    if (!cont) {
      cont = document.createElement('div');
      cont.className = 'bf-avisos';
      cont.setAttribute('role', 'status');
      cont.setAttribute('aria-live', 'polite');
      document.body.appendChild(cont);
    }
    const t = String(texto ?? '');
    const aviso = document.createElement('div');
    aviso.className = `bf-aviso ${tipo || tipoDe(t)}`;
    aviso.textContent = t;
    aviso.onclick = () => cerrar();
    cont.appendChild(aviso);
    const cerrar = () => { aviso.classList.add('saliendo'); setTimeout(() => aviso.remove(), 200); };
    setTimeout(cerrar, Math.min(7000, 2800 + t.length * 35));
  };

  function dialogo(texto, { aceptar = 'Aceptar', cancelar = 'Cancelar', peligro = false, conTexto = false, placeholder = '' } = {}) {
    asegurarEstilo();
    return new Promise(resolve => {
      const fondo = document.createElement('div');
      fondo.className = 'bf-fondo';
      fondo.innerHTML = `<div class="bf-dialogo" role="dialog" aria-modal="true">
        <p></p>${conTexto ? '<input type="text" autocomplete="off">' : ''}
        <div class="bf-botones"><button type="button" class="bf-cancelar"></button><button type="button" class="bf-aceptar${peligro ? ' peligro' : ''}"></button></div>
      </div>`;
      fondo.querySelector('p').textContent = texto;
      fondo.querySelector('.bf-cancelar').textContent = cancelar;
      fondo.querySelector('.bf-aceptar').textContent = aceptar;
      const input = fondo.querySelector('input');
      if (input) input.placeholder = placeholder;
      const terminar = valor => { fondo.remove(); document.removeEventListener('keydown', teclas); resolve(valor); };
      const teclas = e => {
        if (e.key === 'Escape') terminar(conTexto ? null : false);
        if (e.key === 'Enter') terminar(conTexto ? input.value : true);
      };
      fondo.querySelector('.bf-cancelar').onclick = () => terminar(conTexto ? null : false);
      fondo.querySelector('.bf-aceptar').onclick = () => terminar(conTexto ? input.value : true);
      fondo.onclick = e => { if (e.target === fondo) terminar(conTexto ? null : false); };
      document.addEventListener('keydown', teclas);
      document.body.appendChild(fondo);
      (input || fondo.querySelector('.bf-aceptar')).focus();
    });
  }

  window.confirmar = function (texto, opciones = {}) {
    const peligro = opciones.peligro ?? /eliminar|borrar|desvincular|limpiar|quitar/i.test(texto);
    return dialogo(texto, { aceptar: peligro ? 'Sí, continuar' : 'Aceptar', ...opciones, peligro });
  };

  window.pedirTexto = function (texto, placeholder = '') {
    return dialogo(texto, { aceptar: 'Confirmar', peligro: true, conTexto: true, placeholder });
  };
})();
