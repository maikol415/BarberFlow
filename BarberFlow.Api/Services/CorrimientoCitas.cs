using BarberFlow.Api.Models;

namespace BarberFlow.Api.Services;

/// <summary>
/// Cuando el barbero anota en el local una cita que se cruza con las siguientes de su agenda,
/// puede "correrlas": cada cita que choca se mueve justo después de la anterior (redondeado a 10 min),
/// en cadena, hasta que ya no haya cruces. Las citas que empezaron ANTES de la nueva no se mueven.
/// </summary>
public static class CorrimientoCitas
{
    public record Cambio(Cita Cita, string HoraAnterior, string HoraNueva);

    /// <param name="citasAgenda">Citas activas del día en la agenda afectada (ese barbero, o toda la barbería si es de una silla).</param>
    /// <param name="inicio">Minuto del día en que empieza la cita nueva.</param>
    /// <param name="fin">Minuto del día en que termina la cita nueva.</param>
    /// <returns>Los cambios a aplicar, o la cita que lo impide (una que empezó antes y sigue en curso).</returns>
    public static (List<Cambio> Cambios, Cita? Bloqueante) Planear(IEnumerable<Cita> citasAgenda, int inicio, int fin, int duracionPorDefecto)
    {
        int Duracion(Cita c) => c.Servicio?.DuracionMinutos ?? duracionPorDefecto;
        var orden = citasAgenda.OrderBy(c => EstadosCitas.HoraAMinutos(c.Hora)).ToList();

        // Una cita que empieza antes y todavía no termina no se puede correr hacia adelante
        var bloqueante = orden.FirstOrDefault(c =>
        {
            var ci = EstadosCitas.HoraAMinutos(c.Hora);
            return ci < inicio && ci + Duracion(c) > inicio;
        });
        if (bloqueante != null) return (new List<Cambio>(), bloqueante);

        var cambios = new List<Cambio>();
        var cursor = fin;
        foreach (var c in orden.Where(c => EstadosCitas.HoraAMinutos(c.Hora) >= inicio))
        {
            var ci = EstadosCitas.HoraAMinutos(c.Hora);
            if (ci >= cursor) break; // desde aquí ya no hay cruces
            var nuevoInicio = (int)Math.Ceiling(cursor / 10.0) * 10;
            cambios.Add(new Cambio(c, c.Hora, AValor(nuevoInicio)));
            cursor = nuevoInicio + Duracion(c);
        }
        return (cambios, null);
    }

    /// <summary>Formato con el que se guardan las horas: "05:50pm".</summary>
    public static string AValor(int minutos)
    {
        var h = minutos / 60 % 24;
        var m = minutos % 60;
        var h12 = h % 12 == 0 ? 12 : h % 12;
        return $"{h12:00}:{m:00}{(h < 12 ? "am" : "pm")}";
    }
}
