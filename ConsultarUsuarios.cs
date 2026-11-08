using BarberFlow.Api.Data;
using Microsoft.EntityFrameworkCore;

var options = new DbContextOptionsBuilder<AppDbContext>()
    .UseSqlite("Data Source=barberflow.db")
    .Options;

using var db = new AppDbContext(options);

var usuarios = db.Barberos
    .Include(u => u.Barberia)
    .ToList();

if (!usuarios.Any())
{
    Console.WriteLine("NO_USERS_FOUND");
}
else
{
    foreach (var u in usuarios)
    {
        Console.WriteLine($"ID: {u.Id}");
        Console.WriteLine($"NOMBRE: {u.NombreCompleto}");
        Console.WriteLine($"EMAIL: {u.Email}");
        Console.WriteLine($"HASH_PASSWORD: {u.PasswordHash}");
        Console.WriteLine($"BARBERIA: {u.Barberia?.Nombre}");
        Console.WriteLine($"SLUG: {u.Barberia?.Slug}");
        Console.WriteLine($"WHATSAPP: {u.Barberia?.TelefonoWhatsApp}");
        Console.WriteLine("---------------------------------------------");
    }
}
