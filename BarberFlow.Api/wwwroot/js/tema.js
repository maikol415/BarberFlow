// Tema visual de cada barbería: color de marca y portada (foto propia o diseño prediseñado).
// Las páginas usan las clases azules de Tailwind; tema.css las redefine con el color de la barbería.
(function () {
  function hexARgb(hex) {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
    return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null;
  }

  // Mezcla el color con blanco para obtener una versión clara legible sobre fondo oscuro
  function aclarar([r, g, b], cantidad) {
    return [r, g, b].map(c => Math.round(c + (255 - c) * cantidad));
  }

  // Portadas prediseñadas: se dibujan con el color de la barbería (sin subir imágenes)
  const c = (rgb, a) => `rgba(${rgb.join(',')},${a})`;
  const PORTADAS = {
    degradado: { nombre: 'Degradado', css: rgb => `linear-gradient(135deg, ${c(rgb, .55)}, ${c(rgb, .1)} 60%, #0B0F19)` },
    burbujas: {
      nombre: 'Burbujas',
      css: rgb => [
        `radial-gradient(circle at 12% 35%, ${c(rgb, .55)} 0 18px, transparent 19px)`,
        `radial-gradient(circle at 28% 75%, ${c(rgb, .25)} 0 34px, transparent 35px)`,
        `radial-gradient(circle at 48% 25%, ${c(rgb, .35)} 0 12px, transparent 13px)`,
        `radial-gradient(circle at 63% 65%, ${c(rgb, .2)} 0 46px, transparent 47px)`,
        `radial-gradient(circle at 80% 22%, ${c(rgb, .45)} 0 26px, transparent 27px)`,
        `radial-gradient(circle at 93% 80%, ${c(rgb, .3)} 0 16px, transparent 17px)`,
        `linear-gradient(135deg, ${c(rgb, .25)}, #0B0F19 75%)`
      ].join(', ')
    },
    puntos: { nombre: 'Puntos', css: rgb => `radial-gradient(${c(rgb, .5)} 1.6px, transparent 1.8px) 0 0 / 14px 14px, linear-gradient(135deg, ${c(rgb, .3)}, #0B0F19 80%)` },
    rayas: { nombre: 'Rayas', css: rgb => `repeating-linear-gradient(45deg, ${c(rgb, .28)} 0 10px, transparent 10px 24px), linear-gradient(135deg, ${c(rgb, .25)}, #0B0F19 85%)` },
    cuadricula: {
      nombre: 'Cuadrícula',
      css: rgb => `linear-gradient(${c(rgb, .3)} 1px, transparent 1px) 0 0 / 22px 22px, linear-gradient(90deg, ${c(rgb, .3)} 1px, transparent 1px) 0 0 / 22px 22px, linear-gradient(135deg, ${c(rgb, .25)}, #0B0F19 85%)`
    },
    ondas: { nombre: 'Ondas', css: rgb => `repeating-radial-gradient(circle at 50% 130%, ${c(rgb, .22)} 0 2px, transparent 3px 16px), radial-gradient(circle at 50% 130%, ${c(rgb, .55)}, #0B0F19 70%)` },
    barbero: {
      nombre: 'Poste de barbero',
      css: rgb => `repeating-linear-gradient(-45deg, ${c(rgb, .55)} 0 14px, rgba(255,255,255,.1) 14px 28px, rgba(220,38,38,.45) 28px 42px, rgba(255,255,255,.1) 42px 56px)`
    }
  };

  window.PORTADAS_BARBERIA = PORTADAS;

  // Fondo CSS de una portada ("preset:puntos", una foto data:/https:, o vacío = degradado)
  window.fondoPortada = function (portadaUrl, colorHex) {
    const rgb = hexARgb(colorHex) || [37, 99, 235];
    const valor = String(portadaUrl || '');
    if (valor.startsWith('preset:')) {
      const p = PORTADAS[valor.slice(7)] || PORTADAS.degradado;
      return p.css(rgb);
    }
    if (valor) {
      return `linear-gradient(to bottom, rgba(11,15,25,.05), rgba(17,24,39,.95)), url("${valor.replace(/"/g, '%22')}") center / cover`;
    }
    return PORTADAS.degradado.css(rgb);
  };

  window.aplicarTemaBarberia = function (barberia) {
    const rgb = hexARgb(barberia && barberia.colorPrimario);
    if (rgb) {
      const raiz = document.documentElement.style;
      raiz.setProperty('--acento', `rgb(${rgb.join(',')})`);
      raiz.setProperty('--acento-rgb', rgb.join(','));
      raiz.setProperty('--acento-claro', `rgb(${aclarar(rgb, 0.45).join(',')})`);
    }

    const portada = document.getElementById('portada-barberia');
    if (portada && barberia) {
      portada.style.background = window.fondoPortada(barberia.portadaUrl, barberia.colorPrimario);
      if (barberia.portadaUrl) portada.classList.add('con-foto');
    }
  };
})();
