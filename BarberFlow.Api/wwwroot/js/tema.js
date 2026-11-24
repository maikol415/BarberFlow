// Tema visual de cada barbería: color de marca y foto de portada.
// Las páginas usan las clases azules de Tailwind; aquí se redefinen con el color de la barbería.
(function () {
  function hexARgb(hex) {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
    return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null;
  }

  // Mezcla el color con blanco para obtener una versión clara legible sobre fondo oscuro
  function aclarar([r, g, b], cantidad) {
    return [r, g, b].map(c => Math.round(c + (255 - c) * cantidad));
  }

  window.aplicarTemaBarberia = function (barberia) {
    const rgb = hexARgb(barberia && barberia.colorPrimario);
    if (rgb) {
      const raiz = document.documentElement.style;
      raiz.setProperty('--acento', `rgb(${rgb.join(',')})`);
      raiz.setProperty('--acento-rgb', rgb.join(','));
      raiz.setProperty('--acento-claro', `rgb(${aclarar(rgb, 0.45).join(',')})`);
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute('content', '#0B0F19');
    }

    const portada = document.getElementById('portada-barberia');
    if (portada && barberia && barberia.portadaUrl) {
      portada.style.backgroundImage = `linear-gradient(to bottom, rgba(11,15,25,.05), rgba(17,24,39,.95)), url("${String(barberia.portadaUrl).replace(/"/g, '%22')}")`;
      portada.classList.add('con-foto');
    }
  };
})();
