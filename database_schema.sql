-- ============================================================
-- SCRIPT SQL SERVER / AZURE SQL / POSTGRESQL PARA PRODUCCIÓN
-- BarberFlow Pro - SaaS Multi-Barbería
-- ============================================================

-- 1. Tabla de Usuarios (Dueños / Barberos Administradores)
CREATE TABLE Barberos (
    Id INT IDENTITY(1,1) PRIMARY KEY,
    Email NVARCHAR(255) NOT NULL UNIQUE,
    PasswordHash NVARCHAR(MAX) NOT NULL,
    NombreCompleto NVARCHAR(150) NOT NULL,
    FechaRegistro DATETIME2 DEFAULT SYSUTCDATETIME()
);

-- 2. Tabla de Barberías (Negocio)
CREATE TABLE Barberias (
    Id INT IDENTITY(1,1) PRIMARY KEY,
    BarberoUserId INT NOT NULL UNIQUE,
    Nombre NVARCHAR(150) NOT NULL,
    Slug NVARCHAR(100) NOT NULL UNIQUE, -- URL pública para sus clientes: /?b=mi-barberia
    Descripcion NVARCHAR(500) NULL,
    Direccion NVARCHAR(255) NULL,
    TelefonoWhatsApp NVARCHAR(30) NOT NULL,
    LogoUrl NVARCHAR(MAX) NULL,
    HorarioTexto NVARCHAR(150) NULL,
    CONSTRAINT FK_Barberias_Barberos FOREIGN KEY (BarberoUserId) REFERENCES Barberos(Id) ON DELETE CASCADE
);

-- 3. Tabla de Servicios ofrecidos por la Barbería
CREATE TABLE Servicios (
    Id INT IDENTITY(1,1) PRIMARY KEY,
    BarberiaId INT NOT NULL,
    Nombre NVARCHAR(150) NOT NULL,
    Precio DECIMAL(18,2) NOT NULL,
    DuracionMinutos INT DEFAULT 30,
    Descripcion NVARCHAR(500) NULL,
    Icono NVARCHAR(50) DEFAULT 'scissors',
    Activo BIT DEFAULT 1,
    CONSTRAINT FK_Servicios_Barberias FOREIGN KEY (BarberiaId) REFERENCES Barberias(Id) ON DELETE CASCADE
);

-- 4. Tabla de Miembros del Equipo / Barberos
CREATE TABLE Miembros (
    Id INT IDENTITY(1,1) PRIMARY KEY,
    BarberiaId INT NOT NULL,
    Nombre NVARCHAR(150) NOT NULL,
    Rol NVARCHAR(100) DEFAULT 'Master Barber',
    FotoUrl NVARCHAR(MAX) NULL,
    Activo BIT DEFAULT 1,
    CONSTRAINT FK_Miembros_Barberias FOREIGN KEY (BarberiaId) REFERENCES Barberias(Id) ON DELETE CASCADE
);

-- 5. Tabla de Citas (Agendamiento por clientes)
CREATE TABLE Citas (
    Id INT IDENTITY(1,1) PRIMARY KEY,
    BarberiaId INT NOT NULL,
    ServicioId INT NULL,
    MiembroEquipoId INT NULL,
    CodigoReserva NVARCHAR(20) NOT NULL,
    NombreCliente NVARCHAR(150) NOT NULL,
    TelefonoCliente NVARCHAR(30) NOT NULL,
    Fecha NVARCHAR(20) NOT NULL,
    Hora NVARCHAR(20) NOT NULL,
    Total DECIMAL(18,2) NOT NULL,
    Estado NVARCHAR(30) DEFAULT 'Confirmada', -- Confirmada, Completada, Cancelada
    CreadaUtc DATETIME2 DEFAULT SYSUTCDATETIME(),
    CONSTRAINT FK_Citas_Barberias FOREIGN KEY (BarberiaId) REFERENCES Barberias(Id) ON DELETE CASCADE,
    CONSTRAINT FK_Citas_Servicios FOREIGN KEY (ServicioId) REFERENCES Servicios(Id) ON DELETE SET NULL,
    CONSTRAINT FK_Citas_Miembros FOREIGN KEY (MiembroEquipoId) REFERENCES Miembros(Id) ON DELETE SET NULL
);

-- Índices recomendados para alto rendimiento en reservas
CREATE INDEX IX_Citas_BarberiaId ON Citas(BarberiaId);
CREATE INDEX IX_Servicios_BarberiaId ON Servicios(BarberiaId);
CREATE INDEX IX_Barberias_Slug ON Barberias(Slug);
