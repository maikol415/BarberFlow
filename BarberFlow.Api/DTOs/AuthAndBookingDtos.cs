using System.ComponentModel.DataAnnotations;

namespace BarberFlow.Api.DTOs;

public record RegisterDto(
    [Required] string NombreCompleto,
    [Required][EmailAddress] string Email,
    [Required][MinLength(6)] string Password,
    [Required] string NombreBarberia,
    [Required] string TelefonoWhatsApp,
    bool AceptaPrivacidad = false
);

public record LoginDto(
    [Required][EmailAddress] string Email,
    [Required] string Password
);

public record AuthResponseDto(
    string Token,
    string NombreBarbero,
    string Email,
    string BarberiaSlug,
    string NombreBarberia
);

public record UpdateBarberiaDto(
    string Nombre,
    string Descripcion,
    string Direccion,
    string TelefonoWhatsApp,
    string HorarioTexto,
    string LogoUrl,
    string HoraApertura,
    string HoraCierre,
    int IntervaloMinutos,
    string DiasLaborales,
    bool MostrarSelectorBarbero,
    string? DatosPago = null,
    string? NumeroNequi = null,
    string? NumeroDaviplata = null,
    string? TitularCuenta = null,
    bool? BotActivo = null,   // null = no cambiar (antes "true" volvía a encender el bot al guardar otras pestañas)
    string? MensajeBienvenidaBot = null,
    string? MensajeDerivacionHumana = null,
    string? PlantillaConfirmacion = null,
    string? PlantillaRecordatorio = null,
    bool? AnuncioMatutinoActivo = null,
    string? HoraAnuncioSemana = null,
    string? HoraAnuncioSabado = null,
    string? HoraAnuncioDomingo = null,
    int? MinutosAnticipacion = null,
    string? ColorPrimario = null,
    string? PortadaUrl = null,
    bool? RecordatoriosActivos = null,
    int? HorasRecordatorio = null,
    bool? PedirOpinionActivo = null,
    string? HorasRecordatorios = null,
    int? MinutosPausaBot = null,
    string? PortadaPosicion = null,
    string? HorarioSemanal = null,
    int? DiasMaximoReserva = null,
    int? HorasLimiteCancelar = null
);

public record HorarioMiembroDto(string? HorarioSemanal);

public record CrearBotReglaDto(
    string PalabrasClave,
    string Respuesta
);

public record ServicioDto(
    int Id,
    string Categoria,
    string Nombre,
    decimal Precio,
    int DuracionMinutos,
    string Descripcion,
    string Icono,
    bool Activo
);

public record MiembroDto(
    int Id,
    string Nombre,
    string Rol,
    string FotoUrl,
    bool Activo
);

public record CrearCitaPublicaDto(
    [Required] string BarberiaSlug,
    [Required] int ServicioId,
    int? MiembroEquipoId,
    [Required] string NombreCliente,
    [Required] string TelefonoCliente,
    [Required] string Fecha,
    [Required] string Hora,
    string? ReagendarToken = null,
    bool CorrerSiguientes = false   // Solo el barbero: si se cruza, correr las citas siguientes de esa agenda
);

public record CambiarEstadoCitaDto(
    string Estado
);

public record BloqueoDto(
    int Id,
    [Required] string Fecha,
    string? Hora,
    string? Motivo,
    string? FechaHasta = null   // Para bloquear varios días seguidos (vacaciones, viaje...)
);

public record AvisarImprevistoDto(List<int> CitaIds, string? Motivo);

public record UploadImageDto(
    [Required] string ImageData
);

public record ReseñaCitaDto(
    [Required] string Token,
    [Required] int Estrellas,
    string? Comentario
);

public record ClienteRegisterDto(
    [Required] string BarberiaSlug,
    [Required] string Nombre,
    [Required] string Telefono,
    [Required] string Password,
    string? Genero = "Hombre",
    bool AceptaPrivacidad = false
);

public record ClienteLoginDto(
    [Required] string BarberiaSlug,
    [Required] string Telefono,
    [Required] string Password
);
