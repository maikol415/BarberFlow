using System.Text.Json;
using System.Text.RegularExpressions;
using BarberFlow.Api.Models;

namespace BarberFlow.Api.Services;

/// <summary>
/// Horario de atención por día de la semana, con uno o varios rangos por día (ej. 9:00–12:00 y 14:00–20:00)
/// y un interruptor de "día cerrado". Se guarda como JSON:
///   {"1":{"cerrado":false,"rangos":[{"desde":"09:00","hasta":"12:00"},{"desde":"14:00","hasta":"20:00"}]}, ..., "0":{"cerrado":true,"rangos":[]}}
/// (0 = domingo … 6 = sábado). La barbería tiene uno; cada barbero puede tener el suyo propio.
/// Si una barbería todavía no lo configuró, se arma con su hora de apertura/cierre y sus días laborales de antes.
/// </summary>
public static class HorarioSemanal
{
    public class RangoDto { public string Desde { get; set; } = "09:00"; public string Hasta { get; set; } = "20:00"; }
    public class DiaDto { public bool Cerrado { get; set; } public List<RangoDto> Rangos { get; set; } = new(); }

    public record Rango(int Desde, int Hasta);

    private static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true
    };
    private static readonly Regex FormatoHora = new(@"^([01]\d|2[0-3]):[0-5]\d$");

    public static Dictionary<string, DiaDto>? Leer(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return null;
        try { return JsonSerializer.Deserialize<Dictionary<string, DiaDto>>(json, Json); }
        catch (JsonException) { return null; }
    }

    /// <summary>El horario de la barbería (o el armado con los datos antiguos si aún no lo configuró).</summary>
    public static Dictionary<string, DiaDto> DeBarberia(Barberia b)
    {
        var guardado = Leer(b.HorarioSemanal);
        if (guardado != null) return Completar(guardado);
        var dias = (b.DiasLaborales ?? "1,2,3,4,5,6").Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        var resultado = new Dictionary<string, DiaDto>();
        for (var d = 0; d <= 6; d++)
        {
            var abierto = dias.Contains(d.ToString());
            resultado[d.ToString()] = new DiaDto
            {
                Cerrado = !abierto,
                Rangos = abierto ? new List<RangoDto> { new() { Desde = b.HoraApertura ?? "09:00", Hasta = b.HoraCierre ?? "20:00" } } : new()
            };
        }
        return resultado;
    }

    /// <summary>Horario propio del barbero, o null si usa el de la barbería.</summary>
    public static Dictionary<string, DiaDto>? DeMiembro(MiembroEquipo? m) => m == null ? null : Leer(m.HorarioSemanal) is { } h ? Completar(h) : null;

    private static Dictionary<string, DiaDto> Completar(Dictionary<string, DiaDto> h)
    {
        for (var d = 0; d <= 6; d++)
            if (!h.ContainsKey(d.ToString())) h[d.ToString()] = new DiaDto { Cerrado = true };
        return h;
    }

    /// <summary>Rangos (en minutos del día) en que atiende la barbería, o ese barbero si tiene horario propio.</summary>
    public static List<Rango> RangosDelDia(Barberia b, MiembroEquipo? miembro, DayOfWeek dia)
    {
        var horario = DeMiembro(miembro) ?? DeBarberia(b);
        if (!horario.TryGetValue(((int)dia).ToString(), out var d) || d.Cerrado) return new List<Rango>();
        return d.Rangos
            .Select(r => new Rango(EstadosCitas.HoraAMinutos(r.Desde), EstadosCitas.HoraAMinutos(r.Hasta)))
            .Where(r => r.Hasta > r.Desde)
            .OrderBy(r => r.Desde)
            .ToList();
    }

    /// <summary>¿Una cita de [inicio, fin) cabe en alguno de los rangos? (15 min de tolerancia al cierre, como antes)</summary>
    public static bool Cabe(List<Rango> rangos, int inicio, int fin) =>
        rangos.Any(r => inicio >= r.Desde && inicio < r.Hasta && fin <= r.Hasta + 15);

    /// <summary>Valida y deja ordenado el JSON que manda el panel. Devuelve (json, null) o (null, error).</summary>
    public static (string? Json, string? Error) Normalizar(string json)
    {
        var h = Leer(json);
        if (h == null) return (null, "El horario no es válido.");
        var nombres = new[] { "domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado" };
        var limpio = new Dictionary<string, DiaDto>();
        for (var d = 0; d <= 6; d++)
        {
            var dia = h.TryGetValue(d.ToString(), out var x) ? x : new DiaDto { Cerrado = true };
            if (dia.Cerrado) { limpio[d.ToString()] = new DiaDto { Cerrado = true }; continue; }
            if (dia.Rangos.Count == 0) return (null, $"El {nombres[d]} está abierto pero no tiene horas. Agrega un rango o márcalo como cerrado.");
            if (dia.Rangos.Count > 4) return (null, $"El {nombres[d]} tiene demasiados rangos (máximo 4).");
            var rangos = new List<RangoDto>();
            foreach (var r in dia.Rangos)
            {
                if (!FormatoHora.IsMatch(r.Desde ?? "") || !FormatoHora.IsMatch(r.Hasta ?? ""))
                    return (null, $"Revisa las horas del {nombres[d]}.");
                if (EstadosCitas.HoraAMinutos(r.Hasta) <= EstadosCitas.HoraAMinutos(r.Desde))
                    return (null, $"En el {nombres[d]}, la hora final debe ser después de la inicial ({r.Desde}–{r.Hasta}).");
                rangos.Add(new RangoDto { Desde = r.Desde, Hasta = r.Hasta });
            }
            rangos = rangos.OrderBy(r => EstadosCitas.HoraAMinutos(r.Desde)).ToList();
            for (var i = 1; i < rangos.Count; i++)
                if (EstadosCitas.HoraAMinutos(rangos[i].Desde) < EstadosCitas.HoraAMinutos(rangos[i - 1].Hasta))
                    return (null, $"En el {nombres[d]} hay rangos que se cruzan ({rangos[i - 1].Desde}–{rangos[i - 1].Hasta} y {rangos[i].Desde}–{rangos[i].Hasta}).");
            limpio[d.ToString()] = new DiaDto { Cerrado = false, Rangos = rangos };
        }
        if (limpio.Values.All(d => d.Cerrado)) return (null, "Debe quedar al menos un día abierto.");
        return (JsonSerializer.Serialize(limpio, Json), null);
    }

    /// <summary>Para los campos antiguos (hora de apertura/cierre y días laborales), que todavía usan otras partes.</summary>
    public static (string Apertura, string Cierre, string Dias) Resumen(Dictionary<string, DiaDto> h)
    {
        var abiertos = h.Where(kv => !kv.Value.Cerrado && kv.Value.Rangos.Count > 0).ToList();
        if (abiertos.Count == 0) return ("09:00", "20:00", "");
        var desde = abiertos.SelectMany(kv => kv.Value.Rangos).Min(r => EstadosCitas.HoraAMinutos(r.Desde));
        var hasta = abiertos.SelectMany(kv => kv.Value.Rangos).Max(r => EstadosCitas.HoraAMinutos(r.Hasta));
        string HHmm(int m) => $"{m / 60:00}:{m % 60:00}";
        return (HHmm(desde), HHmm(hasta), string.Join(",", abiertos.Select(kv => kv.Key).OrderBy(k => k)));
    }

    public static string ComoJson(Dictionary<string, DiaDto> h) => JsonSerializer.Serialize(h, Json);
}
