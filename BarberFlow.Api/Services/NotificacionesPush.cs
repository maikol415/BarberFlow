using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using BarberFlow.Api.Data;
using BarberFlow.Api.Models;
using Microsoft.EntityFrameworkCore;

namespace BarberFlow.Api.Services;

/// <summary>Llaves VAPID (P-256) en base64url: pública sin comprimir (65 bytes) y privada (32 bytes).</summary>
public record LlavesVapid(string Sujeto, string Publica, string Privada);

/// <summary>
/// Notificaciones push (Android) para el barbero: cita nueva, cancelación y resumen de la mañana.
/// Estándar Web Push: cifrado aes128gcm (RFC 8291) y firma VAPID (RFC 8292), con la criptografía de .NET.
/// Las llaves VAPID salen de las variables VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY o, si no existen,
/// se crean una sola vez y se guardan en la tabla Configuracion (así no hay que configurar nada en Render).
/// </summary>
public static class NotificacionesPush
{
    public const string Nueva = "nueva";
    public const string Cancelacion = "cancelacion";
    public const string Resumen = "resumen";
    public const string Prueba = "prueba";

    public static IServiceScopeFactory? Scopes { get; set; }

    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(15) };
    private static readonly SemaphoreSlim Candado = new(1, 1);
    private static LlavesVapid? _vapid;

    // Servicios de push de los navegadores: solo a estos se les envía (nunca a una URL cualquiera)
    private static readonly string[] HostsPermitidos =
        { "fcm.googleapis.com", "updates.push.services.mozilla.com", "push.services.mozilla.com", "notify.windows.com", "push.apple.com" };

    public static bool EndpointValido(string? endpoint)
    {
        if (!Uri.TryCreate(endpoint, UriKind.Absolute, out var uri)) return false;
        var host = uri.Host.ToLowerInvariant();
        // Solo en desarrollo: un "celular de prueba" en la misma computadora (pruebas automáticas)
        if (uri.IsLoopback && Environment.GetEnvironmentVariable("ASPNETCORE_ENVIRONMENT") == "Development") return true;
        if (uri.Scheme != Uri.UriSchemeHttps) return false;
        return endpoint!.Length <= 1000 && HostsPermitidos.Any(h => host == h || host.EndsWith("." + h));
    }

    // ---------- Llaves VAPID ----------

    public static async Task<LlavesVapid> VapidAsync(AppDbContext db)
    {
        if (_vapid != null) return _vapid;
        await Candado.WaitAsync();
        try
        {
            if (_vapid != null) return _vapid;
            var sujeto = Environment.GetEnvironmentVariable("VAPID_SUBJECT") ?? "https://barberflow-aos9.onrender.com";
            var pub = Environment.GetEnvironmentVariable("VAPID_PUBLIC_KEY");
            var priv = Environment.GetEnvironmentVariable("VAPID_PRIVATE_KEY");
            if (string.IsNullOrWhiteSpace(pub) || string.IsNullOrWhiteSpace(priv))
            {
                var guardadas = await db.Configuracion
                    .Where(c => c.Clave == "VapidPublica" || c.Clave == "VapidPrivada")
                    .ToDictionaryAsync(c => c.Clave, c => c.Valor);
                if (guardadas.TryGetValue("VapidPublica", out var p) && guardadas.TryGetValue("VapidPrivada", out var k))
                {
                    pub = p; priv = k;
                }
                else
                {
                    using var ec = ECDsa.Create(ECCurve.NamedCurves.nistP256);
                    var prm = ec.ExportParameters(true);
                    pub = B64u(Concat(new byte[] { 0x04 }, prm.Q.X!, prm.Q.Y!));
                    priv = B64u(prm.D!);
                    db.Configuracion.Add(new ConfiguracionSistema { Clave = "VapidPublica", Valor = pub });
                    db.Configuracion.Add(new ConfiguracionSistema { Clave = "VapidPrivada", Valor = priv });
                    await db.SaveChangesAsync();
                }
            }
            _vapid = new LlavesVapid(sujeto, pub, priv);
            return _vapid;
        }
        finally { Candado.Release(); }
    }

    // ---------- Envío ----------

    /// <summary>Envía en segundo plano (no hace esperar a quien reservó o canceló).</summary>
    public static void Avisar(int barberiaId, string tipo, string titulo, string cuerpo, string? etiqueta = null)
    {
        _ = Task.Run(async () =>
        {
            try { await EnviarAsync(barberiaId, tipo, titulo, cuerpo, etiqueta); }
            catch (Exception ex) { Console.WriteLine($"[Push] Error avisando a la barbería {barberiaId}: {ex.Message}"); }
        });
    }

    public static async Task<(int Enviadas, int Fallidas)> EnviarAsync(int barberiaId, string tipo, string titulo, string cuerpo,
        string? etiqueta = null, ICollection<int>? soloIds = null, string url = "/admin.html")
    {
        if (Scopes == null) return (0, 0);
        using var scope = Scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

        var consulta = db.SuscripcionesPush.Where(s => s.BarberiaId == barberiaId);
        if (soloIds != null) consulta = consulta.Where(s => soloIds.Contains(s.Id));
        var suscripciones = (await consulta.ToListAsync())
            .Where(s => tipo switch
            {
                Nueva => s.AvisarNuevas,
                Cancelacion => s.AvisarCancelaciones,
                Resumen => s.ResumenMatutino,
                _ => true
            })
            .ToList();
        if (suscripciones.Count == 0) return (0, 0);

        var vapid = await VapidAsync(db);
        var payload = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { titulo, cuerpo, url, etiqueta = etiqueta ?? tipo }));
        // El resumen de la mañana no sirve al otro día; los avisos de citas duran 1 día
        var ttl = tipo == Resumen ? 4 * 3600 : 24 * 3600;

        int enviadas = 0, fallidas = 0;
        var vencidas = new List<SuscripcionPush>();
        foreach (var s in suscripciones)
        {
            try
            {
                var estado = await EnviarUnaAsync(s, payload, vapid, ttl);
                if (estado is HttpStatusCode.Created or HttpStatusCode.OK or HttpStatusCode.Accepted)
                {
                    enviadas++;
                }
                else
                {
                    fallidas++;
                    // 404/410: el barbero desinstaló la app o quitó el permiso
                    if (estado is HttpStatusCode.Gone or HttpStatusCode.NotFound) vencidas.Add(s);
                    else Console.WriteLine($"[Push] El servicio de push respondió {(int)estado} a la suscripción {s.Id}");
                }
            }
            catch (Exception ex)
            {
                fallidas++;
                Console.WriteLine($"[Push] No se pudo enviar a la suscripción {s.Id}: {ex.Message}");
            }
        }
        if (vencidas.Count > 0)
        {
            db.SuscripcionesPush.RemoveRange(vencidas);
            await db.SaveChangesAsync();
        }
        return (enviadas, fallidas);
    }

    private static async Task<HttpStatusCode> EnviarUnaAsync(SuscripcionPush s, byte[] payload, LlavesVapid vapid, int ttl)
    {
        var endpoint = new Uri(s.Endpoint);
        using var req = new HttpRequestMessage(HttpMethod.Post, endpoint)
        {
            Content = new ByteArrayContent(Cifrar(s.P256dh, s.Auth, payload))
        };
        req.Content.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");
        req.Content.Headers.ContentEncoding.Add("aes128gcm");
        req.Headers.TryAddWithoutValidation("TTL", ttl.ToString());
        req.Headers.TryAddWithoutValidation("Urgency", "high");
        req.Headers.TryAddWithoutValidation("Authorization", $"vapid t={FirmaVapid(endpoint, vapid)}, k={vapid.Publica}");
        using var res = await Http.SendAsync(req);
        return res.StatusCode;
    }

    /// <summary>Cifrado de contenido aes128gcm para Web Push (RFC 8291), un solo registro.</summary>
    public static byte[] Cifrar(string p256dh, string auth, byte[] plano)
    {
        var uaPublica = DeB64u(p256dh);
        var secreto = DeB64u(auth);
        if (uaPublica.Length != 65 || uaPublica[0] != 0x04) throw new ArgumentException("Llave p256dh inválida");

        using var ua = ECDiffieHellman.Create(new ECParameters
        {
            Curve = ECCurve.NamedCurves.nistP256,
            Q = new ECPoint { X = uaPublica[1..33], Y = uaPublica[33..65] }
        });
        using var servidor = ECDiffieHellman.Create(ECCurve.NamedCurves.nistP256);
        var prm = servidor.ExportParameters(false);
        var asPublica = Concat(new byte[] { 0x04 }, prm.Q.X!, prm.Q.Y!);
        var compartido = servidor.DeriveRawSecretAgreement(ua.PublicKey);

        var ikm = HKDF.DeriveKey(HashAlgorithmName.SHA256, compartido, 32, secreto,
            Concat(Encoding.ASCII.GetBytes("WebPush: info\0"), uaPublica, asPublica));
        var sal = RandomNumberGenerator.GetBytes(16);
        var cek = HKDF.DeriveKey(HashAlgorithmName.SHA256, ikm, 16, sal, Encoding.ASCII.GetBytes("Content-Encoding: aes128gcm\0"));
        var nonce = HKDF.DeriveKey(HashAlgorithmName.SHA256, ikm, 12, sal, Encoding.ASCII.GetBytes("Content-Encoding: nonce\0"));

        var registro = Concat(plano, new byte[] { 0x02 }); // delimitador del último registro
        var cifrado = new byte[registro.Length];
        var etiqueta = new byte[16];
        using (var aes = new AesGcm(cek, 16)) aes.Encrypt(nonce, registro, cifrado, etiqueta);

        // Encabezado: sal (16) | tamaño de registro (4, = 4096) | largo de la llave (1) | llave pública del servidor (65)
        var rs = new byte[] { 0, 0, 0x10, 0 };
        return Concat(sal, rs, new byte[] { (byte)asPublica.Length }, asPublica, cifrado, etiqueta);
    }

    /// <summary>JWT ES256 de VAPID (RFC 8292): válido 12 horas para el origen del servicio de push.</summary>
    private static string FirmaVapid(Uri endpoint, LlavesVapid vapid)
    {
        var encabezado = B64u(Encoding.UTF8.GetBytes("{\"typ\":\"JWT\",\"alg\":\"ES256\"}"));
        var exp = DateTimeOffset.UtcNow.AddHours(12).ToUnixTimeSeconds();
        var datos = B64u(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { aud = endpoint.GetLeftPart(UriPartial.Authority), exp, sub = vapid.Sujeto })));
        var publica = DeB64u(vapid.Publica);
        using var ec = ECDsa.Create(new ECParameters
        {
            Curve = ECCurve.NamedCurves.nistP256,
            D = DeB64u(vapid.Privada),
            Q = new ECPoint { X = publica[1..33], Y = publica[33..65] }
        });
        var firma = ec.SignData(Encoding.ASCII.GetBytes($"{encabezado}.{datos}"), HashAlgorithmName.SHA256); // r||s (64 bytes)
        return $"{encabezado}.{datos}.{B64u(firma)}";
    }

    private static string B64u(byte[] b) => Convert.ToBase64String(b).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private static byte[] DeB64u(string s)
    {
        var t = s.Trim().Replace('-', '+').Replace('_', '/');
        return Convert.FromBase64String(t + new string('=', (4 - t.Length % 4) % 4));
    }

    private static byte[] Concat(params byte[][] partes)
    {
        var r = new byte[partes.Sum(p => p.Length)];
        var i = 0;
        foreach (var p in partes) { Buffer.BlockCopy(p, 0, r, i, p.Length); i += p.Length; }
        return r;
    }

    // ---------- Textos ----------

    private static readonly string[] Dias = { "dom", "lun", "mar", "mié", "jue", "vie", "sáb" };
    private static readonly string[] Meses = { "ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic" };

    /// <summary>"hoy", "mañana" o "mar 1 dic"</summary>
    public static string TextoFecha(string? iso)
    {
        if (!DateTime.TryParseExact(iso, "yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture,
                System.Globalization.DateTimeStyles.None, out var dia)) return iso ?? "";
        var hoy = EstadosCitas.AhoraColombia().Date;
        if (dia == hoy) return "hoy";
        if (dia == hoy.AddDays(1)) return "mañana";
        return $"{Dias[(int)dia.DayOfWeek]} {dia.Day} {Meses[dia.Month - 1]}";
    }

    /// <summary>"10:00am" -> "10:00 a. m."</summary>
    public static string TextoHora(string? hora)
    {
        var min = EstadosCitas.HoraAMinutos(hora);
        int h = min / 60, m = min % 60;
        return $"{(h % 12 == 0 ? 12 : h % 12)}:{m:00} {(h < 12 ? "a. m." : "p. m.")}";
    }
}

/// <summary>Cada mañana, a la hora que eligió el barbero: "Hoy tienes 5 citas…".</summary>
public class ResumenMatutinoService : BackgroundService
{
    private readonly IServiceScopeFactory _scopes;
    public ResumenMatutinoService(IServiceScopeFactory scopes) => _scopes = scopes;

    // Si la API estaba dormida a esa hora, el resumen aún se envía hasta 3 horas después
    private const int VentanaMinutos = 180;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await Task.Delay(TimeSpan.FromSeconds(30), stoppingToken);
        while (!stoppingToken.IsCancellationRequested)
        {
            try { await RevisarAsync(); }
            catch (Exception ex) { Console.WriteLine($"[Push] Error en el resumen de la mañana: {ex.Message}"); }
            await Task.Delay(TimeSpan.FromMinutes(2), stoppingToken);
        }
    }

    public async Task RevisarAsync()
    {
        using var scope = _scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var ahora = EstadosCitas.AhoraColombia();
        var hoy = ahora.ToString("yyyy-MM-dd");
        var minutos = ahora.Hour * 60 + ahora.Minute;

        var pendientes = (await db.SuscripcionesPush
                .Where(s => s.ResumenMatutino && s.UltimoResumen != hoy)
                .ToListAsync())
            .Where(s =>
            {
                var hora = EstadosCitas.HoraAMinutos(s.HoraResumen);
                return minutos >= hora && minutos < hora + VentanaMinutos;
            })
            .ToList();
        if (pendientes.Count == 0) return;

        foreach (var grupo in pendientes.GroupBy(s => s.BarberiaId))
        {
            // Se marca antes de enviar: si algo falla, no se repite cada 2 minutos
            foreach (var s in grupo) s.UltimoResumen = hoy;
            await db.SaveChangesAsync();

            var mensaje = await ArmarResumenAsync(db, grupo.Key, ahora);
            if (mensaje == null) continue; // día cerrado: no se molesta
            await NotificacionesPush.EnviarAsync(grupo.Key, NotificacionesPush.Resumen, mensaje.Value.Titulo, mensaje.Value.Cuerpo,
                "resumen-" + hoy, grupo.Select(s => s.Id).ToList());
        }
    }

    public static async Task<(string Titulo, string Cuerpo)?> ArmarResumenAsync(AppDbContext db, int barberiaId, DateTime ahora)
    {
        var hoy = ahora.ToString("yyyy-MM-dd");
        var barberia = await db.Barberias
            .Include(b => b.Bloqueos.Where(x => x.Fecha == hoy))
            .Include(b => b.Miembros.Where(m => m.Activo))
            .FirstOrDefaultAsync(b => b.Id == barberiaId);
        if (barberia == null) return null;

        var cerradoTodoElDia = barberia.Bloqueos.Any(x => string.IsNullOrEmpty(x.Hora) || x.Hora == "TODO_EL_DIA");
        var abre = HorarioSemanal.RangosDelDia(barberia, null, ahora.DayOfWeek).Count > 0
                   || barberia.Miembros.Any(m => HorarioSemanal.RangosDelDia(barberia, m, ahora.DayOfWeek).Count > 0);

        var citas = (await db.Citas
                .Include(c => c.Servicio)
                .Where(c => c.BarberiaId == barberiaId && c.Fecha == hoy
                            && c.Estado != EstadosCitas.Cancelada && c.Estado != EstadosCitas.Completada)
                .ToListAsync())
            .OrderBy(c => EstadosCitas.HoraAMinutos(c.Hora))
            .ToList();

        if (citas.Count == 0 && (cerradoTodoElDia || !abre)) return null;

        var titulo = $"☀️ Buenos días · {barberia.Nombre}";
        if (citas.Count == 0)
            return (titulo, "Hoy todavía no tienes citas agendadas. Tu página está lista para recibir reservas.");

        var primera = citas[0];
        var cuerpo = citas.Count == 1
            ? $"Hoy tienes 1 cita: {primera.NombreCliente}, a las {NotificacionesPush.TextoHora(primera.Hora)}"
            : $"Hoy tienes {citas.Count} citas. La primera: {primera.NombreCliente}, a las {NotificacionesPush.TextoHora(primera.Hora)}. La última, a las {NotificacionesPush.TextoHora(citas[^1].Hora)}";
        return (titulo, cuerpo);
    }
}
