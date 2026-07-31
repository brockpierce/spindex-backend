const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

// Set WAL mode for concurrent read/write support
async function init() {
  try {
    await prisma.$executeRawUnsafe("PRAGMA journal_mode=WAL;");
    await prisma.$executeRawUnsafe("PRAGMA busy_timeout=5000;");
    console.log("SQLite WAL mode enabled");
  } catch (e) {
    console.error("SQLite pragma error:", e.message);
  }
}
init();

module.exports = prisma;
