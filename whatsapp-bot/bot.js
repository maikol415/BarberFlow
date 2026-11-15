import makeWASocket, { DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import http from 'http';
import fetch from 'node-fetch';
import fs from 'fs';

const PORT = process.env.PORT || 3001;
const API_BASE_URL = process.env.BARBERFLOW_API_URL || 'https://barberflow-aos9.onrender.com/api/public';
const BARBERIA_SLUG = process.env.BARBERIA_SLUG || 'barberia-jr';

const ultimaRespuestaHumana = new Map();
const estadoCliente = new Map(); // Para saber si está en el menú principal o dentro de categorías de servicios
let cacheBarberia = null;
let ultimaCargaCache = 0;

let ultimoQrDataUrl = '';
let estadoConexion = 'Generando QR...';
let estaConectado = false;

// API REST y Web Server para el Modal del Admin
http.createServer((req, res) => {
  // Encabezados CORS para que el Admin en Render pueda consultar el estado y el QR
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Endpoint para resetear sesión manualmente si se traba
  if (req.url.startsWith('/api/reset')) {
    try {
      fs.rmSync('./auth_info_baileys', { recursive: true, force: true });
    } catch (e) {}
    ultimoQrDataUrl = '';
    estaConectado = false;
    estadoConexion = 'Generando nuevo QR...';
    iniciarBot();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, mensaje: 'Sesión reseteada. QR en camino.' }));
    return;
  }
  if (req.url.startsWith('/api/status')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      conectado: estaConectado,
      estado: estadoConexion,
      qr: ultimoQrDataUrl
    }));
    return;
  }

  // Página embedeable dentro del iframe del modal
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`
    <!DOCTYPE html>
    <html lang="es">
    <head>
      <meta charset="UTF-8">
      <title>QR WhatsApp</title>
      <style>
        body { font-family: sans-serif; background: transparent; color: #111827; display: flex; flex-direction: column; justify-content: center; align-items: center; min-height: 100vh; margin: 0; padding: 10px; text-align: center; }
        .qr-img { width: 230px; height: 230px; border-radius: 12px; margin: 0 auto; display: block; }
        .status { margin-top: 10px; font-weight: bold; color: #059669; font-size: 13px; }
      </style>
      <meta http-equiv="refresh" content="4">
    </head>
    <body>
      ${
        estaConectado 
          ? `<div style="padding:20px;"><h3 style="color:#059669;margin:0;">✅ ¡WhatsApp Conectado!</h3><p style="color:#4B5563;font-size:12px;margin-top:5px;">El bot está activo y listo para responder.</p></div>`
          : ultimoQrDataUrl.startsWith('data:image') 
            ? `<img src="${ultimoQrDataUrl}" class="qr-img" alt="Código QR"><div class="status">${estadoConexion}</div>` 
            : `<div style="padding:30px;color:#6B7280;font-size:13px;">Generando código QR...</div>`
      }
    </body>
    </html>
  `);
}).listen(PORT, () => {
  console.log(`Servidor del Bot y API de estado escuchando en el puerto ${PORT}`);
});

async function iniciarBot() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info_baileys');
  const sock = makeWASocket({ auth: state, printQRInTerminal: false });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      estaConectado = false;
      ultimoQrDataUrl = await QRCode.toDataURL(qr, { width: 280, margin: 2 });
      estadoConexion = 'Apunta con la cámara de WhatsApp';
      console.log('Nuevo QR generado.');
    }

    if (connection === 'close') {
      estaConectado = false;
      const statusCode = (lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(`[Conexión cerrada] StatusCode: ${statusCode} | shouldReconnect: ${shouldReconnect}`);
      
      if (shouldReconnect) {
        estadoConexion = 'Reconectando automáticamente...';
        setTimeout(iniciarBot, 3000);
      } else {
        estadoConexion = 'Sesión expirada. Generando nuevo código QR...';
        // Limpiar credenciales viejas para forzar QR fresco
        try {
          fs.rmSync('./auth_info_baileys', { recursive: true, force: true });
        } catch (e) {}
        setTimeout(iniciarBot, 2000);
      }
    } else if (connection === 'open') {
      estaConectado = true;
      ultimoQrDataUrl = '';
      estadoConexion = 'Conectado';
      console.log('¡WhatsApp en línea y conectado!');
    }
  });

  sock.ev.on('messages.upsert', async (m) => {
    try {
      if (!m.messages || m.messages.length === 0) return;
      const msg = m.messages[0];
      if (!msg.message) return;

      const remitente = msg.key.remoteJid;
      // 🛡️ REGLA 1: Ignorar grupos y difusiones
      if (!remitente || remitente.includes('@g.us') || remitente.includes('broadcast')) return;

      // ⚠️ IMPORTANTE: Si el mensaje lo envió el propio bot, ignorarlo para no procesarse a sí mismo
      if (msg.key.fromMe) return;

      // Extraer texto de cualquier formato de mensaje
      const texto = (
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        msg.message.videoMessage?.caption ||
        msg.message.buttonsResponseMessage?.selectedButtonId ||
        msg.message.listResponseMessage?.singleSelectReply?.selectedRowId ||
        ''
      ).toLowerCase().trim();

      if (!texto) {
        console.log(`[Mensaje Recibido] Sin texto (sticker/multimedia).`);
        return;
      }

      console.log(`[Mensaje Recibido] Remitente: ${remitente} | Texto: "${texto}"`);

      // Limpiar caracteres invisibles, espacios y emojis para comparar números
      const soloNumeros = texto.replace(/[^0-9]/g, '');

      // Función auxiliar para responder de forma natural (escribiendo... ~1.8s)
      const enviarMensajeHumano = async (textoRespuesta) => {
        try {
          await sock.sendPresenceUpdate('composing', remitente);
          await new Promise(r => setTimeout(r, 1800));
          await sock.sendMessage(remitente, { text: textoRespuesta });
          await sock.sendPresenceUpdate('paused', remitente);
        } catch (err) {
          console.error('Error enviando mensaje:', err);
        }
      };

      // Cargar o refrescar datos de la barbería en segundo plano cada 60s
      const ahoraTs = Date.now();
      if (!cacheBarberia || ahoraTs - ultimaCargaCache > 60000) {
        try {
          const res = await fetch(`${API_BASE_URL}/barberia/${BARBERIA_SLUG}`, { timeout: 4000 });
          if (res.ok) {
            const data = await res.json();
            cacheBarberia = data.barberia || data;
            ultimaCargaCache = ahoraTs;
          }
        } catch (fetchErr) {}
      }

      const barberia = cacheBarberia || {
        nombre: 'Barberia JR',
        botActivo: true,
        direccion: 'Calle 45 # 12-34',
        horarioTexto: 'Lunes a Sábado 9:00 AM - 8:00 PM',
        servicios: [
          { categoria: 'Cortes', nombre: 'Corte Moderno', precio: 30000, duracionMinutos: 30 },
          { categoria: 'Cortes', nombre: 'Corte más Barba', precio: 30000, duracionMinutos: 60 },
          { categoria: 'Cortes', nombre: 'Diseño de Barba', precio: 12000, duracionMinutos: 20 },
          { categoria: 'Cortes', nombre: 'Corte + exfoliación facial', precio: 32000, duracionMinutos: 60 },
          { categoria: 'Limpieza facial', nombre: 'Limpieza facial profunda', precio: 17000, duracionMinutos: 40 },
          { categoria: 'Uñas', nombre: 'Arreglo de uñas', precio: 35000, duracionMinutos: 60 },
          { categoria: 'Uñas', nombre: 'Lavado de manos', precio: 15000, duracionMinutos: 30 }
        ]
      };

      if (barberia.botActivo === false) return;

      // Agrupar servicios dinámicamente por categoría
      const serviciosLista = barberia.servicios || [];
      const categoriasMap = new Map();
      serviciosLista.forEach(s => {
        const cat = s.categoria || 'Servicios Generales';
        if (!categoriasMap.has(cat)) categoriasMap.set(cat, []);
        categoriasMap.get(cat).push(s);
      });
      const categoriasNombres = Array.from(categoriasMap.keys());

      // 1. Preguntas Frecuentes personalizadas desde el panel
      const reglas = barberia.botReglas || [];
      for (const regla of reglas) {
        const palabras = regla.palabrasClave.split(',').map(p => p.trim().toLowerCase());
        if (palabras.some(p => p && texto.includes(p))) {
          await enviarMensajeHumano(regla.respuesta);
          return;
        }
      }

      const nivelActual = estadoCliente.get(remitente) || 'INICIO';

      // 0. Si el cliente escribe "0" o "menu" o "volver", regresa al menú principal
      if (soloNumeros === '0' || texto === 'menu' || texto === 'menú' || texto === 'volver' || texto === 'inicio') {
        estadoCliente.set(remitente, 'INICIO');
        const msj = `💈 *Bienvenido a ${barberia.nombre || 'Barberia JR'}*\n\n` +
          `¿En qué te podemos colaborar hoy?\n\n` +
          `1️⃣ 📅 *Agendar tu cita en línea:*\n` +
          `👉 https://barberflow-aos9.onrender.com/index.html?b=${BARBERIA_SLUG}\n\n` +
          `2️⃣ ✂️ *Ver servicios y precios por categorías*\n\n` +
          `3️⃣ 📍 *Ubicación y Horarios*\n\n` +
          `4️⃣ 💳 *Métodos de Pago (Nequi / Bancolombia)*\n\n` +
          `_Responde con el número de tu opción (1, 2, 3 o 4) o escribe tu duda._ ✨`;
        await enviarMensajeHumano(msj);
        return;
      }

      // SI EL CLIENTE ESTÁ DENTRO DEL SUBMENÚ DE SERVICIOS
      if (nivelActual === 'SERVICIOS') {
        const opcionCatIndex = parseInt(soloNumeros, 10) - 1;
        if (!isNaN(opcionCatIndex) && opcionCatIndex >= 0 && opcionCatIndex < categoriasNombres.length) {
          const catSeleccionada = categoriasNombres[opcionCatIndex];
          const serviciosCat = categoriasMap.get(catSeleccionada) || [];

          let lista = `💈 *${catSeleccionada} — ${barberia.nombre || 'Barberia JR'}*\n`;
          lista += `─────────────────────────\n\n`;

          serviciosCat.forEach(s => {
            lista += `✂️ *${s.nombre}*\n`;
            lista += `   💵 $ ${Number(s.precio).toLocaleString('es-CO')}  ·  ⏱️ ${s.duracionMinutos || 30} min\n\n`;
          });

          lista += `─────────────────────────\n`;
          lista += `📅 *Reserva tu turno aquí:* \n👉 https://barberflow-aos9.onrender.com/index.html?b=${BARBERIA_SLUG}\n\n`;
          lista += `_Responde *0* para volver al menú principal._`;

          await enviarMensajeHumano(lista);
          return;
        }
      }

      // 2. Precios y Servicios (Abrir submenú de categorías)
      if (
        soloNumeros === '2' ||
        texto === '2' ||
        texto.includes('precio') || 
        texto.includes('servicios') || 
        texto.includes('servicio') || 
        texto.includes('cuanto vale') || 
        texto.includes('cuánto vale') || 
        texto.includes('cuanto cuesta') || 
        texto.includes('costo') || 
        texto.includes('cortes') || 
        texto.includes('corte')
      ) {
        estadoCliente.set(remitente, 'SERVICIOS');

        let menuServicios = `💈 *Catálogo de Servicios — ${barberia.nombre || 'Barberia JR'}*\n`;
        menuServicios += `Elige la categoría que deseas consultar:\n\n`;

        categoriasNombres.forEach((cat, index) => {
          let icono = '✂️';
          if (cat.toLowerCase().includes('facial') || cat.toLowerCase().includes('limpieza')) icono = '✨';
          else if (cat.toLowerCase().includes('uña') || cat.toLowerCase().includes('manos')) icono = '💅';
          else if (cat.toLowerCase().includes('barba')) icono = '🧔';
          else if (cat.toLowerCase().includes('tinte') || cat.toLowerCase().includes('color')) icono = '🎨';

          menuServicios += `*${index + 1}*️⃣ ${icono} *${cat}*\n`;
        });

        menuServicios += `\n*0*️⃣ 🔙 *Volver al menú principal*\n\n`;
        menuServicios += `_Responde con el número de la categoría para ver sus precios._`;

        await enviarMensajeHumano(menuServicios);
        return;
      }

      // 3. Saludos / Menú principal
      if (
        soloNumeros === '1' ||
        texto === '1' ||
        texto.includes('hola') || 
        texto.includes('buenas') || 
        texto.includes('buenos dias') || 
        texto.includes('buenos días') || 
        texto.includes('buenas tardes') || 
        texto.includes('buenas noches') || 
        texto.includes('info')
      ) {
        estadoCliente.set(remitente, 'INICIO');
        const msj = `💈 *Bienvenido a ${barberia.nombre || 'Barberia JR'}*\n\n` +
          `¿En qué te podemos colaborar hoy?\n\n` +
          `1️⃣ 📅 *Agendar tu cita en línea:*\n` +
          `👉 https://barberflow-aos9.onrender.com/index.html?b=${BARBERIA_SLUG}\n\n` +
          `2️⃣ ✂️ *Ver servicios y precios por categorías*\n\n` +
          `3️⃣ 📍 *Ubicación y Horarios*\n\n` +
          `4️⃣ 💳 *Métodos de Pago (Nequi / Bancolombia)*\n\n` +
          `_Responde con el número de tu opción (1, 2, 3 o 4) o escribe tu duda._ ✨`;

        await enviarMensajeHumano(msj);
        return;
      }

      // 4. Ubicación / Dónde quedan
      if (
        soloNumeros === '3' ||
        texto === '3' ||
        texto.includes('donde') || 
        texto.includes('dónde') || 
        texto.includes('direccion') || 
        texto.includes('dirección') || 
        texto.includes('ubicacion') || 
        texto.includes('ubicación')
      ) {
        const ubi = `📍 *Ubicación y Horario de Atención:*\n\n` +
          `🏠 *Dirección:* ${barberia.direccion || 'Calle 45 # 12-34'}\n` +
          `⏰ *Horario:* ${barberia.horarioTexto || 'Lunes a Sábado 9:00 AM - 8:00 PM'}\n\n` +
          `📅 *Reserva tu cita aquí para no hacer fila:* \n👉 https://barberflow-aos9.onrender.com/index.html?b=${BARBERIA_SLUG}`;
        await enviarMensajeHumano(ubi);
        return;
      }

      // 5. Métodos de Pago y Transferencias
      if (
        soloNumeros === '4' ||
        texto === '4' ||
        texto.includes('pago') || 
        texto.includes('pagar') || 
        texto.includes('nequi') || 
        texto.includes('bancolombia') || 
        texto.includes('transferencia') || 
        texto.includes('efectivo')
      ) {
        let msgPago = `💳 *Métodos de Pago — ${barberia.nombre || 'Barberia JR'}*\n`;
        msgPago += `─────────────────────────\n\n`;
        msgPago += `💵 *Efectivo:* Recibimos en el local al finalizar tu servicio.\n\n`;
        
        if (barberia.numeroNequi) {
          msgPago += `📱 *Nequi:* ${barberia.numeroNequi}\n`;
        }

        if (barberia.numeroDaviplata) {
          msgPago += `🏦 *Bancolombia:* ${barberia.numeroDaviplata}\n`;
        }

        if (barberia.titularCuenta) {
          msgPago += `👤 *Titular:* ${barberia.titularCuenta}\n`;
        }

        if (barberia.datosPago) {
          msgPago += `\nℹ️ _${barberia.datosPago}_\n`;
        }

        msgPago += `\n─────────────────────────\n`;
        msgPago += `📅 *Reserva tu cita aquí:* \n👉 https://barberflow-aos9.onrender.com/index.html?b=${BARBERIA_SLUG}`;

        await enviarMensajeHumano(msgPago);
        return;
      }

      // 6. DERIVACIÓN HUMANA INTELIGENTE (Para cualquier pregunta libre)
      const ahora = Date.now();
      const ultimaVezDerivado = ultimaRespuestaHumana.get(remitente) || 0;
      const diezMinutosMs = 10 * 60 * 1000;

      if (ahora - ultimaVezDerivado > diezMinutosMs) {
        const derivacion = barberia.mensajeDerivacionHumana || 
          'He tomado nota de tu consulta. En este momento el barbero está en servicio con un cliente ✂️💈. Tan pronto termine su turno te responderá personalmente por este chat.';
        
        await enviarMensajeHumano(derivacion);
        ultimaRespuestaHumana.set(remitente, ahora);
      }

    } catch (e) {
      console.error('Error procesando mensaje en bot:', e);
    }
  });
}

iniciarBot();
