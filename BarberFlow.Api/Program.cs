using System.Text;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.EntityFrameworkCore;
using Microsoft.IdentityModel.Tokens;
using BarberFlow.Api.Data;
using BarberFlow.Api.Models;

var builder = WebApplication.CreateBuilder(args);

// Configuración de Base de Datos (Soporta Supabase / PostgreSQL, SQL Server o SQLite local)
var supabaseConn = Environment.GetEnvironmentVariable("DATABASE_URL") 
                   ?? builder.Configuration.GetConnectionString("SupabaseConnection");
var useSqlServer = builder.Configuration.GetValue<bool>("UseSqlServer");

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
            var npgsqlConn = $"Host={host};Port={port};Database={uri.AbsolutePath.TrimStart('/')};Username={userInfo[0]};Password={userInfo[1]};SSL Mode=Require;Trust Server Certificate=true;Timeout=60;Command Timeout=60;Pooling=false";
            options.UseNpgsql(npgsqlConn);
        }
        else
        {
            options.UseNpgsql(supabaseConn);
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
var jwtKey = builder.Configuration["Jwt:Key"] ?? "ClaveSecretaSuperSeguraParaBarberFlow2026!DebeTenerMasDe32Caracteres";
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
        IssuerSigningKey = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(jwtKey)),
        ValidateIssuer = false,
        ValidateAudience = false,
        ClockSkew = TimeSpan.Zero
    };
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
builder.Services.AddEndpointsApiExplorer();

var app = builder.Build();

// Crear y poblar automáticamente la Base de Datos con tu usuario si está limpia
using (var scope = app.Services.CreateScope())
{
    var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
    db.Database.EnsureCreated();

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
app.UseStaticFiles();

app.UseAuthentication();
app.UseAuthorization();

app.MapControllers();

app.Run();
