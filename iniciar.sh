#!/bin/sh
# Arranca la API y, si BOT_INTEGRADO=1, también el bot de WhatsApp en el mismo servicio de Render.
# Así un solo servicio gratis (750 h/mes) mantiene despiertas la página y el bot.
#
# El bot es el gestor de varias barberías (whatsapp-bot/gestor.js): enciende una copia del bot por
# cada barbería con su WhatsApp vinculado. Reutiliza las variables que ya tiene la API:
# DATABASE_URL, BOT_API_KEY y BOT_BARBERIA_SLUG. La API y el bot se hablan por dentro (127.0.0.1).

if [ "$BOT_INTEGRADO" = "1" ]; then
  export BOT_PORT="${BOT_PORT:-3001}"
  export BARBERFLOW_BOT_URL="http://127.0.0.1:${BOT_PORT}"
  (
    cd /app/bot || exit 1
    export BARBERFLOW_API_URL="http://127.0.0.1:${PORT:-8080}/api/public"
    export BARBERIA_SLUG="${BARBERIA_SLUG:-$BOT_BARBERIA_SLUG}"
    # Memoria por barbería: el plan gratis tiene 512 MB para la API, el gestor y los bots
    export BOT_MEMORIA_HIJO_MB="${BOT_MEMORIA_HIJO_MB:-128}"
    sleep 8 # que la API arranque primero
    while true; do
      node --max-old-space-size=48 gestor.js
      echo "[bot] El gestor se detuvo. Se reinicia en 10 s..."
      sleep 10
    done
  ) &
fi

exec dotnet BarberFlow.Api.dll
