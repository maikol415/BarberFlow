namespace BarberFlow.Api.Models;

public class BarberoUser
{
    public int Id { get; set; }
    public string Email { get; set; } = string.Empty;
    public string PasswordHash { get; set; } = string.Empty;
    public string NombreCompleto { get; set; } = string.Empty;
    public DateTime FechaRegistro { get; set; } = DateTime.UtcNow;

    public Barberia? Barberia { get; set; }
}

public class Barberia
{
    public int Id { get; set; }
    public int BarberoUserId { get; set; }
    public BarberoUser? BarberoUser { get; set; }

    public string Nombre { get; set; } = "Mi Barbería Pro";
    public string Slug { get; set; } = "mi-barberia";
    public string Descripcion { get; set; } = "Cortes clásicos, degradados y perfilado de barba.";
    public string Direccion { get; set; } = "Calle 45 # 12-34";
    public string TelefonoWhatsApp { get; set; } = "573001234567";
    public string LogoUrl { get; set; } = "";
    public string HorarioTexto { get; set; } = "Lunes a Sábado 9:00 AM - 8:00 PM";

    // Horarios laborales base (de qué hora a qué hora trabaja la barbería)
    public string HoraApertura { get; set; } = "09:00"; // Formato 24h ej: 09:00
    public string HoraCierre { get; set; } = "20:00";   // Formato 24h ej: 20:00
    public int IntervaloMinutos { get; set; } = 40;     // Cada 30, 40 o 45 min
    public string DiasLaborales { get; set; } = "1,2,3,4,5,6"; // 1=Lun, 2=Mar, 3=Mié, 4=Jue, 5=Vie, 6=Sáb, 0=Dom

    // Activar o desactivar selector de barbero
    public bool MostrarSelectorBarbero { get; set; } = false;

    // Colecciones
    public List<Servicio> Servicios { get; set; } = new();
    public List<MiembroEquipo> Miembros { get; set; } = new();
    public List<Cita> Citas { get; set; } = new();
    public List<HorarioBloqueo> Bloqueos { get; set; } = new();
    public List<Valoracion> Valoraciones { get; set; } = new();
}

public class Valoracion
{
    public int Id { get; set; }
    public int BarberiaId { get; set; }
    public string NombreCliente { get; set; } = string.Empty;
    public int Estrellas { get; set; } = 5; // 1 a 5 estrellas
    public string Comentario { get; set; } = string.Empty;
    public DateTime FechaUtc { get; set; } = DateTime.UtcNow;
}

public class Servicio
{
    public int Id { get; set; }
    public int BarberiaId { get; set; }
    public string Categoria { get; set; } = "Cortes"; // Cortes, Barba, Limpieza facial, Combos
    public string Nombre { get; set; } = string.Empty;
    public decimal Precio { get; set; }
    public int DuracionMinutos { get; set; } = 30;
    public string Descripcion { get; set; } = string.Empty;
    public string Icono { get; set; } = "scissors";
    public bool Activo { get; set; } = true;
}

public class MiembroEquipo
{
    public int Id { get; set; }
    public int BarberiaId { get; set; }
    public string Nombre { get; set; } = string.Empty;
    public string Rol { get; set; } = "Master Barber";
    public string FotoUrl { get; set; } = "";
    public bool Activo { get; set; } = true;
}

public class Cita
{
    public int Id { get; set; }
    public int BarberiaId { get; set; }
    public int? ServicioId { get; set; }
    public Servicio? Servicio { get; set; }
    public int? MiembroEquipoId { get; set; }
    public MiembroEquipo? MiembroEquipo { get; set; }

    public string CodigoReserva { get; set; } = string.Empty;
    public string NombreCliente { get; set; } = string.Empty;
    public string TelefonoCliente { get; set; } = string.Empty;
    public string Fecha { get; set; } = string.Empty; // YYYY-MM-DD
    public string Hora { get; set; } = string.Empty;  // Ej: 09:00am o 10:30am
    public decimal Total { get; set; }
    public string Estado { get; set; } = "Confirmada";
    public DateTime CreadaUtc { get; set; } = DateTime.UtcNow;
}

public class HorarioBloqueo
{
    public int Id { get; set; }
    public int BarberiaId { get; set; }
    public string Fecha { get; set; } = string.Empty;
    public string? Hora { get; set; }
    public string Motivo { get; set; } = "Descanso / No disponible";
}
