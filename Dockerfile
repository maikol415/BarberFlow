# Etapa 1: Compilación de la API
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src

COPY ["BarberFlow.Api/BarberFlow.Api.csproj", "BarberFlow.Api/"]
RUN dotnet restore "BarberFlow.Api/BarberFlow.Api.csproj"

COPY . .
WORKDIR "/src/BarberFlow.Api"
RUN dotnet publish "BarberFlow.Api.csproj" -c Release -o /app/publish /p:UseAppHost=false

# Etapa 2: Dependencias del bot de WhatsApp (Node)
FROM node:22-bookworm-slim AS bot
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/* \
    && git config --global url."https://github.com/".insteadOf ssh://git@github.com/
WORKDIR /bot
COPY whatsapp-bot/package.json whatsapp-bot/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY whatsapp-bot/bot.js whatsapp-bot/auth-postgres.js ./

# Etapa 3: Entorno de ejecución (API + bot en el mismo servicio)
FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS final
WORKDIR /app

# Instalar dependencias para SSL / Kerberos / PostgreSQL en Linux
RUN apt-get update && apt-get install -y --no-install-recommends libgssapi-krb5-2 ca-certificates && rm -rf /var/lib/apt/lists/*

# Node para el bot (solo el ejecutable; el bot se enciende con BOT_INTEGRADO=1)
COPY --from=bot /usr/local/bin/node /usr/local/bin/node
COPY --from=bot /bot /app/bot

COPY --from=build /app/publish .
COPY iniciar.sh /app/iniciar.sh
RUN sed -i 's/\r$//' /app/iniciar.sh && chmod +x /app/iniciar.sh

# Puerto estándar para Railway / Render
ENV ASPNETCORE_URLS=http://+:8080
ENV PORT=8080
# Menos memoria para la API: la comparte con el bot (plan gratis de 512 MB)
ENV DOTNET_gcServer=0
EXPOSE 8080

ENTRYPOINT ["/app/iniciar.sh"]
