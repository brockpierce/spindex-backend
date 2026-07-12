// A single shared database connection, reused by every route file.
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

// Enable WAL mode for better concurrent read/write performance.
// Runs once on startup inside the server's own connection.
prisma.$executeRawUnsafe("PRAGMA journal_mode=WAL;")
  .catch((e) => console.error("WAL mode error:", e.message));

module.exports = prisma;
