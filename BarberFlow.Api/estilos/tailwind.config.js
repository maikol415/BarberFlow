/** Configuración de Tailwind para generar wwwroot/css/app.css (ver estilos/entrada.css). */
module.exports = {
  content: ['./wwwroot/**/*.html', './wwwroot/js/**/*.js', '!./wwwroot/js/**/*.min.js', '!./wwwroot/js/iconos.js'],
  theme: {
    extend: {
      fontFamily: { sans: ['"Plus Jakarta Sans"', 'sans-serif'] }
    }
  },
  plugins: []
};
