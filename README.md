# BarberFlow Pro - Plataforma SaaS para Barberías

Este proyecto ha sido modularizado y estructurado con backend en **.NET 10 (ASP.NET Core Web API + Entity Framework Core)**, base de datos relacional (con soporte dual: SQLite local y SQL Server/Azure en producción) y un frontend moderno en **HTML5, Tailwind CSS y JavaScript**.

---

## 📁 Estructura del Proyecto

```text
BarberFlow_Project/
├── database_schema.sql         # Script SQL Server / Azure SQL listo para producción
└── BarberFlow.Api/
    ├── Controllers/
    │   ├── AuthController.cs   # Registro y Login de barberos (genera tokens JWT)
    │   ├── AdminController.cs  # Modificar barbería, agregar servicios/barberos y citas
    │   └── PublicController.cs # API pública para que el cliente reserve sin registrarse
    ├── Data/
    │   └── AppDbContext.cs     # Contexto Entity Framework con relaciones
    ├── DTOs/
    │   └── AuthAndBookingDtos.cs
    ├── Models/
    │   └── Entities.cs         # Modelos: BarberoUser, Barberia, Servicio, MiembroEquipo, Cita
    ├── wwwroot/                # Frontend Web Estático Servido por .NET
    │   ├── index.html          # Vista PÚBLICA del cliente (sin panel administrativo)
    │   ├── login.html          # Vista de Registro / Login exclusivo para barberos
    │   ├── admin.html          # Panel PRIVADO del barbero (requiere sesión JWT)
    │   └── js/
    │       ├── client.js       # Wizard de reservas dinámico con envío a WhatsApp
    │       ├── auth.js         # Lógica de login/registro
    │       └── admin.js        # Gestión de servicios, precios, equipo y tabla de citas
    ├── appsettings.json
    └── Program.cs
```

---

## 🔒 Privacidad y Flujo de Trabajo

1. **Clientes (Público)**:
   - Ingresan a la URL pública: `http://localhost:5000/index.html?b=tu-barberia`.
   - **No necesitan registrarse ni ingresar contraseñas.**
   - No tienen acceso ni botones hacia el panel de administración.
   - Eligen servicio, barbero, fecha/horario, confirman sus datos y envían el resumen directamente al WhatsApp de la barbería.

2. **Barberos (Privado)**:
   - Ingresan a `/login.html` para registrar su barbería o iniciar sesión.
   - La contraseña se guarda con hash seguro (**BCrypt**).
   - Acceden al panel privado (`/admin.html`) protegido por **JWT**:
     - Modifican nombre de la barbería, dirección, teléfono de WhatsApp y horarios.
     - Crean y eliminan servicios con sus precios y duración.
     - Añaden barberos a su equipo.
     - Gestionan las citas en tiempo real (Confirmar, Completar, Cancelar).

---

## ☁️ Base de Datos Gratis en la Nube

Para probar sin gastar nada:
1. **Localmente (Listo para usar sin pagar ni configurar servidores)**:
   - Ya está configurado con **SQLite** (`barberflow.db`), se crea automáticamente al iniciar.
2. **En la Nube (Gratis)**:
   - Puedes usar servicios gratuitos como **Neon.tech** / **Supabase** o la capa gratuita de **Azure SQL Database** (32 GB gratis).
   - El script completo de creación de tablas está listo en [`database_schema.sql`](file:///C:/Users/maiko/.gemini/antigravity/scratch/BarberFlow_Project/database_schema.sql).
   - Solo debes actualizar la cadena de conexión en [`appsettings.json`](file:///C:/Users/maiko/.gemini/antigravity/scratch/BarberFlow_Project/BarberFlow.Api/appsettings.json) y poner `"UseSqlServer": true`.

---

## 🚀 Cómo Ejecutar el Proyecto

Abre una terminal PowerShell y ejecuta:

```powershell
cd "C:\Users\maiko\.gemini\antigravity\scratch\BarberFlow_Project\BarberFlow.Api"
dotnet run
```

Luego abre en tu navegador:
- **Vista Cliente:** `http://localhost:5000/index.html`
- **Portal Barbero:** `http://localhost:5000/login.html`
- **Panel Privado:** `http://localhost:5000/admin.html`
