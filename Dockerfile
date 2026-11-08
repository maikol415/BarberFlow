# Etapa 1: Compilación
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src

COPY ["BarberFlow.Api/BarberFlow.Api.csproj", "BarberFlow.Api/"]
RUN dotnet restore "BarberFlow.Api/BarberFlow.Api.csproj"

COPY . .
WORKDIR "/src/BarberFlow.Api"
RUN dotnet publish "BarberFlow.Api.csproj" -c Release -o /app/publish /p:UseAppHost=false

# Etapa 2: Entorno de ejecución
FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS final
WORKDIR /app
COPY --from=build /app/publish .

# Puerto estándar para Railway / Render
ENV ASPNETCORE_URLS=http://+:8080
ENV PORT=8080
EXPOSE 8080

ENTRYPOINT ["dotnet", "BarberFlow.Api.dll"]
