using System.Text;
using BarberFlow.Api.Services;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.EntityFrameworkCore;
using Microsoft.IdentityModel.Tokens;
using BarberFlow.Api.Data;
using BarberFlow.Api.Models;
using Microsoft.EntityFrameworkCore.Infrastructure;

var builder = WebApplication.CreateBuilder(args);

// Configuración de Base de Datos (Soporta Supabase / PostgreSQL, SQL Server o SQLite local)
var supabaseConn = Environment.GetEnvironmentVariable("DATABASE_URL")
                   ?? builder.Configuration.GetConnectionString("SupabaseConnection");
var useSqlServer = builder.Configuration.GetValue<bool>("UseSqlServer");

// Reutilizar conexiones a PostgreSQL (antes Pooling=false abría una conexión cifrada nueva en CADA consulta:
// ~0,5 s por consulta y ~3 s para cargar la página de una barbería). Se mantiene una conexión caliente,
// se renuevan las inactivas y Keepalive evita que Supabase/Render las corten en silencio.
const string PoolConexiones = "Pooling=true;Minimum Pool Size=1;Maximum Pool Size=15;Connection Idle Lifetime=120;Connection Pruning Interval=30;Keepalive=30;No Reset On Close=true";

builder.Services.AddDbContext<AppDbContext>(options =>
{
    if (!string.IsNullOrWhiteSpace(supabaseConn))
    {
        // Conexión directa a Supabase (PostgreSQL)
        // Convertir formato postgres:// si viene de variable de entorno
        if (supabaseConn.StartsWith("postgres://") || supabaseConn.StartsWith("postgresql://"))
        {
            var uri = new Uri(supabaseConn);
            var userInfo = uri.UserInfo.Split(':');
            var port = uri.Port > 0 ? uri.Port : 5432;
            var host = uri.Host;
            // Para Render / Supabase: si usa direct pooler o db host, forzar IPv4 si es necesario
            var npgsqlConn = $"Host={host};Port={port};Database={uri.AbsolutePath.TrimStart('/')};Username={userInfo[0]};Password={userInfo[1]};SSL Mode=Require;Trust Server Certificate=true;Timeout=60;Command Timeout=60;{PoolConexiones}";
            options.UseNpgsql(npgsqlConn);
        }
        else
        {
            // Si viene en formato normal ADO.NET (Host=...;Port=6543...)
            // Asegurar parámetros robustos para el Supabase Pooler
            var connBuilder = supabaseConn;
            if (!connBuilder.Contains("Pooling=", StringComparison.OrdinalIgnoreCase))
            {
                connBuilder += ";" + PoolConexiones;
            }
            if (!connBuilder.Contains("Timeout=", StringComparison.OrdinalIgnoreCase))
            {
                connBuilder += ";Timeout=30;Command Timeout=30";
            }
            if (!connBuilder.Contains("Keepalive=", StringComparison.OrdinalIgnoreCase))
            {
                connBuilder += ";Keepalive=30";
            }
            options.UseNpgsql(connBuilder);
        }
    }
    else if (useSqlServer)
    {
        var sqlServerConn = builder.Configuration.GetConnectionString("SqlServerConnection");
        options.UseSqlServer(sqlServerConn);
    }
    else
    {
        var sqliteConn = builder.Configuration.GetConnectionString("DefaultConnection") ?? "Data Source=barberflow.db";
        options.UseSqlite(sqliteConn);
    }
});

// Configuración de Autenticación JWT
// La clave se lee de la variable de entorno Jwt__Key (o JWT_KEY). Nunca debe estar en el repositorio.
var jwtKey = builder.Configuration["Jwt:Key"] ?? Environment.GetEnvironmentVariable("JWT_KEY");
if (string.IsNullOrWhiteSpace(jwtKey) || jwtKey.Length < 32)
{
    throw new InvalidOperationException(
        "Falta la clave JWT. Define la variable de entorno Jwt__Key (mínimo 32 caracteres) en Render. " +
        "En desarrollo local se toma de appsettings.Development.json.");
}
if (!builder.Environment.IsDevelopment() && jwtKey.StartsWith("solo-desarrollo-local"))
{
    throw new InvalidOperationException("Se está usando la clave JWT de desarrollo fuera de Development. Define Jwt__Key en el servidor.");
}
var tokenService = new TokenService(jwtKey);
builder.Services.AddSingleton(tokenService);

builder.Services.AddAuthentication(options =>
{
    options.DefaultAuthenticateScheme = JwtBearerDefaults.AuthenticationScheme;
    options.DefaultChallengeScheme = JwtBearerDefaults.AuthenticationScheme;
})
.AddJwtBearer(options =>
{
    options.RequireHttpsMetadata = false;
    options.SaveToken = true;
    options.TokenValidationParameters = new TokenValidationParameters
    {
        ValidateIssuerSigningKey = true,
        IssuerSigningKey = tokenService.Key,
        ValidateIssuer = false,
        ValidateAudience = false,
        ClockSkew = TimeSpan.Zero
    };
});

builder.Services.AddAuthorization(options =>
{
    options.AddPolicy(PoliticasAuth.Barbero, p => p.RequireClaim(PoliticasAuth.ClaimBarberiaId));
    options.AddPolicy(PoliticasAuth.Cliente, p => p.RequireClaim(PoliticasAuth.ClaimClienteId));
});

builder.Services.AddCors(options =>
{
    options.AddPolicy("AllowAll", policy =>
    {
        policy.AllowAnyOrigin()
              .AllowAnyMethod()
              .AllowAnyHeader();
    });
});

builder.Services.AddControllers();
builder.Services.AddHostedService<AutomatizacionCitasService>();
builder.Services.AddHostedService<ResumenMatutinoService>();
builder.Services.AddEndpointsApiExplorer();

var app = builder.Build();
NotificacionesPush.Scopes = app.Services.GetRequiredService<IServiceScopeFactory>();

// Crear y poblar automáticamente la Base de Datos con tu usuario si está limpia
using (var scope = app.Services.CreateScope())
{
    var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

    // Si es PostgreSQL (Supabase), crear las tablas si no existen
    if (db.Database.IsNpgsql())
    {
        var creator = db.Database.GetService<Microsoft.EntityFrameworkCore.Storage.IRelationalDatabaseCreator>();
        try
        {
            creator.CreateTables();
        }
        catch
        {
            // Las tablas principales ya existían
        }

        // Asegurar que las columnas de pagos y bot existan en Barberias
        try
        {
            db.Database.ExecuteSqlRaw(@"
                ALTER TABLE ""Barberias"" ADD COLUMN IF NOT EXISTS ""DatosPago"" text DEFAULT 'Aceptamos Efectivo en el local, transferencias por Nequi y Daviplata.';
                ALTER TABLE ""Barberias"" ADD COLUMN IF NOT EXISTS ""NumeroNequi"" text DEFAULT '';
                ALTER TABLE ""Barberias"" ADD COLUMN IF NOT EXISTS ""NumeroDaviplata"" text DEFAULT '';
                ALTER TABLE ""Barberias"" ADD COLUMN IF NOT EXISTS ""TitularCuenta"" text DEFAULT '';
                ALTER TABLE ""Barberias"" ADD COLUMN IF NOT EXISTS ""BotActivo"" boolean DEFAULT true;
                ALTER TABLE ""Barberias"" ADD COLUMN IF NOT EXISTS ""MensajeBienvenidaBot"" text DEFAULT '¡Hola! 💈 Bienvenido. ¿En qué podemos ayudarte?';
                ALTER TABLE ""Barberias"" ADD COLUMN IF NOT EXISTS ""MensajeDerivacionHumana"" text DEFAULT 'En este momento el barbero está en servicio con un cliente ✂️💈. Tan pronto termine, te responderá personalmente por este chat.';
                ALTER TABLE ""Barberias"" ADD COLUMN IF NOT EXISTS ""PlantillaConfirmacion"" text DEFAULT '';
                ALTER TABLE ""Barberias"" ADD COLUMN IF NOT EXISTS ""PlantillaRecordatorio"" text DEFAULT '';
                ALTER TABLE ""Barberias"" ADD COLUMN IF NOT EXISTS ""AnuncioMatutinoActivo"" boolean DEFAULT true;
                ALTER TABLE ""Barberias"" ADD COLUMN IF NOT EXISTS ""HoraAnuncioSemana"" text DEFAULT '08:00';
                ALTER TABLE ""Barberias"" ADD COLUMN IF NOT EXISTS ""HoraAnuncioSabado"" text DEFAULT '08:00';
                ALTER TABLE ""Barberias"" ADD COLUMN IF NOT EXISTS ""HoraAnuncioDomingo"" text DEFAULT '09:00';
                ALTER TABLE ""Barberias"" ADD COLUMN IF NOT EXISTS ""MinutosAnticipacion"" integer NOT NULL DEFAULT 30;
                ALTER TABLE ""Barberias"" ADD COLUMN IF NOT EXISTS ""ColorPrimario"" text NOT NULL DEFAULT '#2563EB';
                ALTER TABLE ""Barberias"" ADD COLUMN IF NOT EXISTS ""PortadaUrl"" text NOT NULL DEFAULT '';
                ALTER TABLE ""Barberias"" ADD COLUMN IF NOT EXISTS ""RecordatoriosActivos"" boolean NOT NULL DEFAULT true;
                ALTER TABLE ""Barberias"" ADD COLUMN IF NOT EXISTS ""HorasRecordatorio"" integer NOT NULL DEFAULT 2;
                ALTER TABLE ""Barberias"" ADD COLUMN IF NOT EXISTS ""PedirOpinionActivo"" boolean NOT NULL DEFAULT true;
                ALTER TABLE ""Barberias"" ADD COLUMN IF NOT EXISTS ""HorasRecordatorios"" text NOT NULL DEFAULT '24,2';
                ALTER TABLE ""Barberias"" ADD COLUMN IF NOT EXISTS ""MinutosPausaBot"" integer NOT NULL DEFAULT 120;
                ALTER TABLE ""Barberias"" ADD COLUMN IF NOT EXISTS ""ReaccionesPortada"" text NOT NULL DEFAULT '';
                ALTER TABLE ""Barberias"" ADD COLUMN IF NOT EXISTS ""PortadaPosicion"" text NOT NULL DEFAULT '50 50';
                ALTER TABLE ""Barberias"" ADD COLUMN IF NOT EXISTS ""ReaccionesLogo"" text NOT NULL DEFAULT '';
                ALTER TABLE ""Barberias"" ADD COLUMN IF NOT EXISTS ""HorarioSemanal"" text NOT NULL DEFAULT '';
                ALTER TABLE ""Barberias"" ADD COLUMN IF NOT EXISTS ""DiasMaximoReserva"" integer NOT NULL DEFAULT 30;
                ALTER TABLE ""Barberias"" ADD COLUMN IF NOT EXISTS ""HorasLimiteCancelar"" integer NOT NULL DEFAULT 2;
                ALTER TABLE ""Miembros"" ADD COLUMN IF NOT EXISTS ""HorarioSemanal"" text NOT NULL DEFAULT '';
                ALTER TABLE ""Barberos"" ADD COLUMN IF NOT EXISTS ""AceptoPrivacidadUtc"" timestamp with time zone NULL;
                ALTER TABLE ""Clientes"" ADD COLUMN IF NOT EXISTS ""AceptoPrivacidadUtc"" timestamp with time zone NULL;
                ALTER TABLE ""Barberos"" ADD COLUMN IF NOT EXISTS ""CodigoRecuperacionHash"" text NULL;
                ALTER TABLE ""Barberos"" ADD COLUMN IF NOT EXISTS ""CodigoRecuperacionVence"" timestamp with time zone NULL;
                ALTER TABLE ""Barberos"" ADD COLUMN IF NOT EXISTS ""CodigoRecuperacionIntentos"" integer NOT NULL DEFAULT 0;
                ALTER TABLE ""Barberos"" ADD COLUMN IF NOT EXISTS ""CodigoRecuperacionEnviado"" timestamp with time zone NULL;
                ALTER TABLE ""Clientes"" ADD COLUMN IF NOT EXISTS ""CodigoRecuperacionHash"" text NULL;
                ALTER TABLE ""Clientes"" ADD COLUMN IF NOT EXISTS ""CodigoRecuperacionVence"" timestamp with time zone NULL;
                ALTER TABLE ""Clientes"" ADD COLUMN IF NOT EXISTS ""CodigoRecuperacionIntentos"" integer NOT NULL DEFAULT 0;
                ALTER TABLE ""Clientes"" ADD COLUMN IF NOT EXISTS ""CodigoRecuperacionEnviado"" timestamp with time zone NULL;
            ");
        }
        catch (Exception ex)
        {
            Console.WriteLine($"Nota en migración de columnas: {ex.Message}");
        }

        // Asegurar que la tabla Valoraciones exista aunque las otras tablas ya estuviesen creadas
        try
        {
            db.Database.ExecuteSqlRaw(@"
                CREATE TABLE IF NOT EXISTS ""Valoraciones"" (
                    ""Id"" integer GENERATED BY DEFAULT AS IDENTITY,
                    ""BarberiaId"" integer NOT NULL,
                    ""NombreCliente"" text NOT NULL,
                    ""Estrellas"" integer NOT NULL,
                    ""Comentario"" text NULL,
                    ""FechaUtc"" timestamp with time zone NOT NULL,
                    CONSTRAINT ""PK_Valoraciones"" PRIMARY KEY (""Id""),
                    CONSTRAINT ""FK_Valoraciones_Barberias_BarberiaId"" FOREIGN KEY (""BarberiaId"") REFERENCES ""Barberias"" (""Id"") ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS ""Clientes"" (
                    ""Id"" integer GENERATED BY DEFAULT AS IDENTITY,
                    ""BarberiaId"" integer NOT NULL,
                    ""Nombre"" text NOT NULL,
                    ""Telefono"" text NOT NULL,
                    ""Genero"" text DEFAULT 'Hombre',
                    ""PasswordHash"" text NOT NULL,
                    ""FechaRegistro"" timestamp with time zone NOT NULL,
                    CONSTRAINT ""PK_Clientes"" PRIMARY KEY (""Id""),
                    CONSTRAINT ""FK_Clientes_Barberias_BarberiaId"" FOREIGN KEY (""BarberiaId"") REFERENCES ""Barberias"" (""Id"") ON DELETE CASCADE
                );
            ");
        }
        catch (Exception ex)
        {
            Console.WriteLine($"Error creando tabla Valoraciones: {ex.Message}");
        }

        // Notificaciones push del panel (celulares del barbero) y configuración interna (llaves VAPID)
        try
        {
            db.Database.ExecuteSqlRaw(@"
                CREATE TABLE IF NOT EXISTS ""SuscripcionesPush"" (
                    ""Id"" integer GENERATED BY DEFAULT AS IDENTITY,
                    ""BarberiaId"" integer NOT NULL,
                    ""Endpoint"" text NOT NULL,
                    ""P256dh"" text NOT NULL,
                    ""Auth"" text NOT NULL,
                    ""Dispositivo"" text NOT NULL DEFAULT '',
                    ""AvisarNuevas"" boolean NOT NULL DEFAULT true,
                    ""AvisarCancelaciones"" boolean NOT NULL DEFAULT true,
                    ""ResumenMatutino"" boolean NOT NULL DEFAULT true,
                    ""HoraResumen"" text NOT NULL DEFAULT '07:00',
                    ""UltimoResumen"" text NOT NULL DEFAULT '',
                    ""CreadoUtc"" timestamp with time zone NOT NULL DEFAULT now(),
                    CONSTRAINT ""PK_SuscripcionesPush"" PRIMARY KEY (""Id""),
                    CONSTRAINT ""FK_SuscripcionesPush_Barberias_BarberiaId"" FOREIGN KEY (""BarberiaId"") REFERENCES ""Barberias"" (""Id"") ON DELETE CASCADE
                );
                CREATE UNIQUE INDEX IF NOT EXISTS ""IX_SuscripcionesPush_Endpoint"" ON ""SuscripcionesPush"" (""Endpoint"");
                CREATE INDEX IF NOT EXISTS ""IX_SuscripcionesPush_BarberiaId"" ON ""SuscripcionesPush"" (""BarberiaId"");
                CREATE TABLE IF NOT EXISTS ""Configuracion"" (
                    ""Clave"" text NOT NULL,
                    ""Valor"" text NOT NULL,
                    CONSTRAINT ""PK_Configuracion"" PRIMARY KEY (""Clave"")
                );
            ");
        }
        catch (Exception ex)
        {
            Console.WriteLine($"Error creando tablas de notificaciones: {ex.Message}");
        }

        // Token público por cita (enlaces de reseña / reagendar) y marca de reseña única.
        // Las citas antiguas reciben un token aleatorio (gen_random_uuid usa el generador seguro de PostgreSQL).
        try
        {
            db.Database.ExecuteSqlRaw(@"
                ALTER TABLE ""Citas"" ADD COLUMN IF NOT EXISTS ""TokenPublico"" text NOT NULL DEFAULT '';
                ALTER TABLE ""Citas"" ADD COLUMN IF NOT EXISTS ""CalificadaUtc"" timestamp with time zone NULL;
                UPDATE ""Citas"" SET ""TokenPublico"" = replace(gen_random_uuid()::text, '-', '') WHERE ""TokenPublico"" IS NULL OR ""TokenPublico"" = '';
                CREATE UNIQUE INDEX IF NOT EXISTS ""IX_Citas_TokenPublico"" ON ""Citas"" (""TokenPublico"");
            ");
        }
        catch (Exception ex)
        {
            Console.WriteLine($"Error migrando TokenPublico de Citas: {ex.Message}");
        }
    }
    else
    {
        db.Database.EnsureCreated();

        // SQLite local: EnsureCreated no agrega columnas nuevas a una base ya creada
        if (db.Database.IsSqlite())
        {
            foreach (var sql in new[]
            {
                @"ALTER TABLE ""Citas"" ADD COLUMN ""TokenPublico"" TEXT NOT NULL DEFAULT ''",
                @"ALTER TABLE ""Citas"" ADD COLUMN ""CalificadaUtc"" TEXT NULL",
                @"ALTER TABLE ""Barberias"" ADD COLUMN ""MinutosAnticipacion"" INTEGER NOT NULL DEFAULT 30",
                @"ALTER TABLE ""Barberias"" ADD COLUMN ""ColorPrimario"" TEXT NOT NULL DEFAULT '#2563EB'",
                @"ALTER TABLE ""Barberias"" ADD COLUMN ""PortadaUrl"" TEXT NOT NULL DEFAULT ''",
                @"ALTER TABLE ""Barberias"" ADD COLUMN ""RecordatoriosActivos"" INTEGER NOT NULL DEFAULT 1",
                @"ALTER TABLE ""Barberias"" ADD COLUMN ""HorasRecordatorio"" INTEGER NOT NULL DEFAULT 2",
                @"ALTER TABLE ""Barberias"" ADD COLUMN ""PedirOpinionActivo"" INTEGER NOT NULL DEFAULT 1",
                @"ALTER TABLE ""Barberias"" ADD COLUMN ""HorasRecordatorios"" TEXT NOT NULL DEFAULT '24,2'",
                @"ALTER TABLE ""Barberias"" ADD COLUMN ""MinutosPausaBot"" INTEGER NOT NULL DEFAULT 120",
                @"ALTER TABLE ""Barberias"" ADD COLUMN ""ReaccionesPortada"" TEXT NOT NULL DEFAULT ''",
                @"ALTER TABLE ""Barberias"" ADD COLUMN ""PortadaPosicion"" TEXT NOT NULL DEFAULT '50 50'",
                @"ALTER TABLE ""Barberias"" ADD COLUMN ""HorarioSemanal"" TEXT NOT NULL DEFAULT ''",
                @"ALTER TABLE ""Barberias"" ADD COLUMN ""DiasMaximoReserva"" INTEGER NOT NULL DEFAULT 30",
                @"ALTER TABLE ""Barberias"" ADD COLUMN ""HorasLimiteCancelar"" INTEGER NOT NULL DEFAULT 2",
                @"ALTER TABLE ""Miembros"" ADD COLUMN ""HorarioSemanal"" TEXT NOT NULL DEFAULT ''",
                @"ALTER TABLE ""Barberos"" ADD COLUMN ""AceptoPrivacidadUtc"" TEXT NULL",
                @"ALTER TABLE ""Clientes"" ADD COLUMN ""AceptoPrivacidadUtc"" TEXT NULL",
                @"ALTER TABLE ""Barberos"" ADD COLUMN ""CodigoRecuperacionHash"" TEXT NULL",
                @"ALTER TABLE ""Barberos"" ADD COLUMN ""CodigoRecuperacionVence"" TEXT NULL",
                @"ALTER TABLE ""Barberos"" ADD COLUMN ""CodigoRecuperacionIntentos"" INTEGER NOT NULL DEFAULT 0",
                @"ALTER TABLE ""Barberos"" ADD COLUMN ""CodigoRecuperacionEnviado"" TEXT NULL",
                @"ALTER TABLE ""Clientes"" ADD COLUMN ""CodigoRecuperacionHash"" TEXT NULL",
                @"ALTER TABLE ""Clientes"" ADD COLUMN ""CodigoRecuperacionVence"" TEXT NULL",
                @"ALTER TABLE ""Clientes"" ADD COLUMN ""CodigoRecuperacionIntentos"" INTEGER NOT NULL DEFAULT 0",
                @"ALTER TABLE ""Clientes"" ADD COLUMN ""CodigoRecuperacionEnviado"" TEXT NULL",
                @"ALTER TABLE ""Barberias"" ADD COLUMN ""ReaccionesLogo"" TEXT NOT NULL DEFAULT ''"
            })
            {
                try { db.Database.ExecuteSqlRaw(sql); } catch { /* la columna ya existía */ }
            }

            var citasSinToken = db.Citas.Where(c => c.TokenPublico == "").ToList();
            foreach (var c in citasSinToken) c.TokenPublico = Cita.NuevoTokenPublico();
            if (citasSinToken.Count > 0) db.SaveChanges();

            db.Database.ExecuteSqlRaw(@"CREATE UNIQUE INDEX IF NOT EXISTS ""IX_Citas_TokenPublico"" ON ""Citas"" (""TokenPublico"")");

            // Tablas nuevas que EnsureCreated no agrega a una base ya creada
            db.Database.ExecuteSqlRaw(@"
                CREATE TABLE IF NOT EXISTS ""SuscripcionesPush"" (
                    ""Id"" INTEGER NOT NULL CONSTRAINT ""PK_SuscripcionesPush"" PRIMARY KEY AUTOINCREMENT,
                    ""BarberiaId"" INTEGER NOT NULL,
                    ""Endpoint"" TEXT NOT NULL,
                    ""P256dh"" TEXT NOT NULL,
                    ""Auth"" TEXT NOT NULL,
                    ""Dispositivo"" TEXT NOT NULL DEFAULT '',
                    ""AvisarNuevas"" INTEGER NOT NULL DEFAULT 1,
                    ""AvisarCancelaciones"" INTEGER NOT NULL DEFAULT 1,
                    ""ResumenMatutino"" INTEGER NOT NULL DEFAULT 1,
                    ""HoraResumen"" TEXT NOT NULL DEFAULT '07:00',
                    ""UltimoResumen"" TEXT NOT NULL DEFAULT '',
                    ""CreadoUtc"" TEXT NOT NULL DEFAULT '2026-01-01 00:00:00',
                    CONSTRAINT ""FK_SuscripcionesPush_Barberias_BarberiaId"" FOREIGN KEY (""BarberiaId"") REFERENCES ""Barberias"" (""Id"") ON DELETE CASCADE
                );
                CREATE UNIQUE INDEX IF NOT EXISTS ""IX_SuscripcionesPush_Endpoint"" ON ""SuscripcionesPush"" (""Endpoint"");
                CREATE TABLE IF NOT EXISTS ""Configuracion"" (
                    ""Clave"" TEXT NOT NULL CONSTRAINT ""PK_Configuracion"" PRIMARY KEY,
                    ""Valor"" TEXT NOT NULL
                );
            ");
        }
    }

    if (!db.Barberos.Any())
    {
        var user = new BarberoUser
        {
            NombreCompleto = "Michael Stiven Castro Alvarez",
            Email = "michaelcastro415@gmail.com",
            PasswordHash = "$2a$11$uWGBgWGz6iicCZXZi52HnuFz94tPW9/MsIfMQ0b8TKSQ8MLT/p4qy"
        };

        var defaultAvatar = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%2364748B'><circle cx='12' cy='8' r='4'/><path d='M4 20c0-4 4-6 8-6s8 2 8 6'/></svg>";

        var barberia = new Barberia
        {
            Nombre = "Barberia JR",
            Slug = "barberia-jr",
            Descripcion = "Barbería & Cuidado personal",
            Direccion = "Calle 45 # 12-34",
            TelefonoWhatsApp = "+573024084425",
            LogoUrl = defaultAvatar,
            HorarioTexto = "Lunes a Sábado 9:00 AM - 8:00 PM",
            HoraApertura = "09:00",
            HoraCierre = "20:00",
            IntervaloMinutos = 40,
            DiasLaborales = "1,2,3,4,5,6",
            MostrarSelectorBarbero = false,
            BarberoUser = user
        };

        // Categoría: Cortes
        barberia.Servicios.Add(new Servicio { Categoria = "Cortes", Nombre = "Diseño de Barba", Precio = 12000, DuracionMinutos = 20, Descripcion = "Elaboración de corte y diseño de barba", Icono = "scissors" });
        barberia.Servicios.Add(new Servicio { Categoria = "Cortes", Nombre = "Corte Moderno", Precio = 20000, DuracionMinutos = 40, Descripcion = "Diseño y corte de cabello para caballero", Icono = "scissors" });
        barberia.Servicios.Add(new Servicio { Categoria = "Cortes", Nombre = "Corte más Barba", Precio = 30000, DuracionMinutos = 60, Descripcion = "Procedemos a realizar corte de caballero y barba completa", Icono = "scissors" });
        barberia.Servicios.Add(new Servicio { Categoria = "Cortes", Nombre = "Corte + exfoliación facial", Precio = 32000, DuracionMinutos = 60, Descripcion = "Procedemos a realizar el servicio de corte y exfoliación", Icono = "scissors" });
        barberia.Servicios.Add(new Servicio { Categoria = "Cortes", Nombre = "Corte + barba + limpieza facial", Precio = 42000, DuracionMinutos = 60, Descripcion = "Realizamos el diseño de corte acompañado de tratamiento completo", Icono = "crown" });

        // Categoría: Limpieza facial
        barberia.Servicios.Add(new Servicio { Categoria = "Limpieza facial", Nombre = "Limpieza facial profunda", Precio = 17000, DuracionMinutos = 40, Descripcion = "Servicio donde extraemos impurezas y aplicamos mascarilla", Icono = "sparkles" });

        barberia.Miembros.Add(new MiembroEquipo { Nombre = "Michael Stiven Castro Alvarez", Rol = "Master Barber / Dueño", FotoUrl = defaultAvatar });

        db.Barberos.Add(user);
        db.Barberias.Add(barberia);
        db.SaveChanges();
    }
}

app.UseCors("AllowAll");
app.UseDefaultFiles();

var fileOptions = new StaticFileOptions();
var provider = new Microsoft.AspNetCore.StaticFiles.FileExtensionContentTypeProvider();
provider.Mappings[".json"] = "application/json";
provider.Mappings[".webmanifest"] = "application/manifest+json";
fileOptions.ContentTypeProvider = provider;
// Las páginas HTML, el service worker y los manifests se revisan siempre con el servidor (con ETag no se
// descargan de nuevo si no cambiaron). Así, tras cada despliegue nadie se queda con una versión vieja.
fileOptions.OnPrepareResponse = ctx =>
{
    var nombre = ctx.File.Name.ToLowerInvariant();
    if (nombre.EndsWith(".html") || nombre == "sw.js" || nombre.EndsWith(".json"))
    {
        ctx.Context.Response.Headers["Cache-Control"] = "no-cache";
    }
    else if (ctx.Context.Request.Query.ContainsKey("v"))
    {
        // Archivos versionados (?v=...): el navegador los guarda un año; al cambiar se cambia el ?v= en el HTML
        ctx.Context.Response.Headers["Cache-Control"] = "public, max-age=31536000, immutable";
    }
    else if (nombre.EndsWith(".png") || nombre.EndsWith(".svg") || nombre.EndsWith(".jpg") || nombre.EndsWith(".webp"))
    {
        ctx.Context.Response.Headers["Cache-Control"] = "public, max-age=604800";
    }
};
app.UseStaticFiles(fileOptions);

app.UseAuthentication();
app.UseAuthorization();

// Endpoint de salud ligero para mantener despierto Render 24/7 sin tocar la base de datos
app.MapGet("/ping", () => Results.Ok(new { status = "active", time = DateTime.UtcNow }));

app.MapControllers();

app.Run();
