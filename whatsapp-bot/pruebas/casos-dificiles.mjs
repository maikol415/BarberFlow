// Casos difíciles para el bot (API LOCAL). Uso: node pruebas/casos-dificiles.mjs
process.env.BOT_MODO_PRUEBA = '1';
const { procesarMensajeEntrante, textoHorario } = await import('../bot.js');

let fallos = 0;
const ok = (c, m, extra = '') => { console.log(`${c ? '✅' : '❌'} ${m}${extra ? ' — ' + extra : ''}`); if (!c) fallos++; };

// ---------- Horario en texto ----------
const dia = (rangos) => ({ cerrado: !rangos.length, rangos: rangos.map(([desde, hasta]) => ({ desde, hasta })) });
const todos = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map(d => [d, dia([['11:00', '21:00']])]));
ok(textoHorario({ horarioSemanal: todos }) === 'Todos los días: 11:00 a. m. – 9:00 p. m.', 'Horario igual toda la semana', textoHorario({ horarioSemanal: todos }));
const semana = { ...Object.fromEntries([1, 2, 3, 4, 5].map(d => [d, dia([['09:00', '19:00']])])), 6: dia([['09:00', '14:00']]), 0: dia([]) };
const t2 = textoHorario({ horarioSemanal: semana });
ok(t2 === 'Lunes a viernes: 9:00 a. m. – 7:00 p. m.\nSábado: 9:00 a. m. – 2:00 p. m.\nDomingo: cerrado', 'Lunes a viernes / sábado / domingo cerrado', JSON.stringify(t2));
const partido = { ...todos, 3: dia([['14:00', '18:00'], ['08:00', '12:00']]) };
ok(textoHorario({ horarioSemanal: partido }).includes('Miércoles: 8:00 a. m. – 12:00 p. m. y 2:00 p. m. – 6:00 p. m.'), 'Jornada partida, ordenada', JSON.stringify(textoHorario({ horarioSemanal: partido })));
ok(textoHorario({ horarioSemanal: JSON.stringify(todos) }).startsWith('Todos los días'), 'Horario que llega como texto JSON');
ok(textoHorario({ horaApertura: '08:00', horaCierre: '18:00', diasLaborales: '1,2,3,4,5,6' }) === 'Lunes a sábado: 8:00 a. m. – 6:00 p. m.\nDomingo: cerrado', 'Sin horario por días: usa apertura, cierre y días', JSON.stringify(textoHorario({ horaApertura: '08:00', horaCierre: '18:00', diasLaborales: '1,2,3,4,5,6' })));
ok(textoHorario({ horarioTexto: 'Solo con cita' }) === 'Solo con cita', 'Sin ningún horario: usa el texto escrito a mano');
ok(textoHorario({ horarioSemanal: Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map(d => [d, dia([])])) }) === '', 'Todo cerrado: no inventa un horario');
const dosDias = { ...todos, 6: dia([['09:00', '13:00']]), 0: dia([['09:00', '13:00']]) };
ok(textoHorario({ horarioSemanal: dosDias }).includes('Sábado y domingo: 9:00 a. m. – 1:00 p. m.'), 'Dos días iguales seguidos: "Sábado y domingo"');

// ---------- Mensajes raros ----------
const enviados = [];
const sock = {
  sendMessage: async (jid, c) => { enviados.push({ jid, texto: c?.text || '' }); },
  sendPresenceUpdate: async () => {},
  onWhatsApp: async (n) => [{ exists: true, jid: `${n}@s.whatsapp.net` }]
};
let n = 0;
const base = Math.floor(1000000 + Math.random() * 8999999);
async function msg(jid, message, extra = {}) {
  enviados.length = 0;
  let error = null;
  try {
    await procesarMensajeEntrante(sock, { type: 'notify', messages: [{ key: { remoteJid: jid, fromMe: false, id: `RARO${++n}`, ...extra }, message }] });
  } catch (e) { error = e; }
  return { error, texto: enviados.filter(e => e.jid === jid).map(e => e.texto).join('\n---\n') };
}
const chat = (p) => `57319${p}${base}@s.whatsapp.net`;

let r = await msg(chat(1), { conversation: '👍' });
ok(!r.error, 'Solo un emoji: no falla', r.texto.slice(0, 60));
r = await msg(chat(2), { conversation: 'a'.repeat(5000) });
ok(!r.error && r.texto.length < 3000, 'Texto de 5000 letras: no falla ni repite el texto', `${r.texto.length} letras`);
r = await msg(chat(3), { imageMessage: { caption: '' } });
ok(!r.error && r.texto === '', 'Foto sin texto: silencio');
r = await msg(chat(4), { stickerMessage: {} });
ok(!r.error && r.texto === '', 'Sticker: silencio');
r = await msg(chat(5), { audioMessage: { seconds: 9 } });
ok(!r.error && r.texto === '', 'Nota de voz: silencio (no se puede entender)');
r = await msg(chat(6), { reactionMessage: { text: '❤️' } });
ok(!r.error && r.texto === '', 'Reacción con corazón: silencio');
r = await msg(chat(7), { extendedTextMessage: { text: 'Hola' } });
ok(!r.error && /Bienvenid/.test(r.texto), 'Texto con formato (extendedTextMessage)');
await msg(chat(8), { conversation: 'Hola' });
for (const t of ['4️⃣', ' 4 ', '4.', '4)']) {
  r = await msg(chat(8), { conversation: t });
  ok(!r.error && /citas|cita/i.test(r.texto), `Opción escrita como ${JSON.stringify(t)}`, r.texto.slice(0, 50).replace(/\n/g, ' '));
}
r = await msg(chat(9), { conversation: '<script>alert(1)</script>' });
ok(!r.error && !r.texto.includes('<script>'), 'Texto con código: no lo repite');
r = await msg('99999999999999@lid', { conversation: '4' });
ok(!r.error, 'Chat @lid sin número conocido, escribe "4": no falla', r.texto.slice(0, 80).replace(/\n/g, ' '));
r = await msg('99999999999999@lid', { conversation: 'Mis citas' });
ok(!r.error && r.texto.length > 0, 'Chat @lid sin número: "Mis citas" responde algo útil', r.texto.slice(0, 120).replace(/\n/g, ' '));
r = await msg('120363000000000000@g.us', { conversation: 'Hola' });
ok(!r.error && r.texto === '', 'Mensaje en un grupo: silencio');
r = await msg('status@broadcast', { conversation: 'Hola' });
ok(!r.error && r.texto === '', 'Estado de WhatsApp: silencio');
r = await msg(chat(10), { conversation: 'Hola' }, { fromMe: true });
ok(!r.error && r.texto === '', 'Mensaje del propio barbero: el bot no se responde a sí mismo');
r = await msg(chat(11), { protocolMessage: { type: 0 } });
ok(!r.error && r.texto === '', 'Mensaje borrado (protocolo): silencio');
r = await msg(chat(12), { conversation: 'Reserva tu cita aquí https://barberflow-aos9.onrender.com/otra-barberia' });
ok(!r.error && r.texto === '', 'Mensaje de otro bot BarberFlow (con el enlace): no se arma un bucle');

console.log(fallos ? `\n${fallos} prueba(s) fallaron ❌` : '\nTodo OK ✅');
process.exit(fallos ? 1 : 0);
