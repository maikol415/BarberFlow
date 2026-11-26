#!/bin/sh
# Arranca la API y, si BOT_INTEGRADO=1, también el bot de WhatsApp en el mismo servicio de Render.
# Así un solo servicio gratis (750 h/mes) mantiene despiertas la página y el bot.
#
# El bot reutiliza las variables que ya tiene la API: DATABASE_URL, BOT_API_KEY y BOT_BARBERIA_SLUG.
# La API y el bot se hablan por dentro (127.0.0.1), sin salir a internet.

if [ "$BOT_INTEGRADO" = "1" ]; then
  export BOT_PORT="${BOT_PORT:-3001}"
  export BARBERFLOW_BOT_URL="http://127.0.0.1:${BOT_PORT}"
  (
    cd /app/bot || exit 1
    export BARBERFLOW_API_URL="http://127.0.0.1:${PORT:-8080}/api/public"
    export BARBERIA_SLUG="${BARBERIA_SLUG:-$BOT_BARBERIA_SLUG}"
    sleep 8 # que la API arranque primero
    while true; do
      node --max-old-space-size="${BOT_MEMORIA_MB:-192}" bot.js
      echo "[bot] Se detuvo. Se reinicia en 10 s..."
      sleep 10
    done
  ) &
fi

exec dotnet BarberFlow.Api.dll
