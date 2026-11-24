// Genera wwwroot/js/iconos.js con SOLO los íconos de Lucide que usan las páginas (en vez de la librería
// completa de ~730 KB). Ejecutar desde BarberFlow.Api cuando se use un ícono nuevo:
//   node estilos/generar-iconos.cjs
const fs = require('fs');
const path = require('path');

const raiz = path.join(__dirname, '..', 'wwwroot');
const lucide = require(path.join(__dirname, 'lucide.min.js'));

const aKebab = nombre => nombre.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/([A-Z])([A-Z][a-z])/g, '$1-$2').replace(/([a-zA-Z])(\d)/g, '$1-$2').toLowerCase();
const porNombre = new Map(Object.entries(lucide.icons).map(([pascal, nodo]) => [aKebab(pascal), nodo]));

// Todos los textos entre comillas de los .html y .js propios: los que coinciden con un ícono se incluyen
const archivos = [
  ...fs.readdirSync(raiz).filter(f => f.endsWith('.html')).map(f => path.join(raiz, f)),
  ...fs.readdirSync(path.join(raiz, 'js')).filter(f => f.endsWith('.js') && !f.endsWith('.min.js') && f !== 'iconos.js').map(f => path.join(raiz, 'js', f))
];
const usados = new Set();
for (const archivo of archivos) {
  const texto = fs.readFileSync(archivo, 'utf8');
  for (const m of texto.matchAll(/["'`]([a-z][a-z0-9-]*)["'`]/g)) if (porNombre.has(m[1])) usados.add(m[1]);
  for (const m of texto.matchAll(/data-lucide="([a-z0-9-]+)"/g)) {
    if (porNombre.has(m[1])) usados.add(m[1]);
    else console.warn(`Ícono desconocido en ${path.basename(archivo)}: ${m[1]}`);
  }
}

const iconos = Object.fromEntries([...usados].sort().map(n => [n, porNombre.get(n)]));
const salida = `// Generado por estilos/generar-iconos.cjs (Lucide v1.71, licencia ISC). Solo los íconos usados en la web.
(function () {
  var ICONOS = ${JSON.stringify(iconos)};
  var NS = 'http://www.w3.org/2000/svg';
  function crear(tag, attrs) {
    var el = document.createElementNS(NS, tag);
    for (var k in attrs) el.setAttribute(k, attrs[k]);
    return el;
  }
  function createIcons() {
    document.querySelectorAll('i[data-lucide], span[data-lucide]').forEach(function (el) {
      var nombre = el.getAttribute('data-lucide');
      var nodo = ICONOS[nombre];
      if (!nodo) return;
      var svg = crear('svg', {
        xmlns: NS, width: 24, height: 24, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
        'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
        'class': ('lucide lucide-' + nombre + ' ' + (el.getAttribute('class') || '')).trim(),
        'aria-hidden': 'true'
      });
      if (el.id) svg.id = el.id;
      nodo.forEach(function (hijo) { svg.appendChild(crear(hijo[0], hijo[1])); });
      el.replaceWith(svg);
    });
  }
  window.lucide = { createIcons: createIcons, icons: ICONOS };
})();
`;
fs.writeFileSync(path.join(raiz, 'js', 'iconos.js'), salida);
console.log(`${usados.size} íconos → js/iconos.js (${(Buffer.byteLength(salida) / 1024).toFixed(1)} KB)`);
