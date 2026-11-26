// Política de privacidad: muestra el nombre y el contacto de la barbería (?b=slug)
(async function () {
  document.querySelectorAll('.anio-actual').forEach(e => { e.textContent = new Date().getFullYear(); });
  const slug = (new URLSearchParams(location.search).get('b') || '').toLowerCase();
  if (!slug) return;
  document.getElementById('link-volver').href = `/${encodeURIComponent(slug)}`;
  try {
    const res = await fetch(`/api/public/barberia/${encodeURIComponent(slug)}`);
    if (!res.ok) return;
    const b = await res.json();
    if (window.aplicarTemaBarberia) aplicarTemaBarberia(b);
    document.title = `Política de privacidad · ${b.nombre}`;
    document.querySelectorAll('.nombre-barberia').forEach(e => { e.textContent = b.nombre; });
    const tel = String(b.telefonoWhatsApp || '').replace(/\D/g, '');
    if (tel) {
      const enlace = ` (WhatsApp <a href="https://wa.me/${tel}" target="_blank" rel="noopener" class="text-cyan-300 underline">+${tel}</a>)`;
      ['contacto-barberia', 'contacto-barberia-2'].forEach(id => { document.getElementById(id).innerHTML = enlace; });
    }
  } catch (e) {}
})();
