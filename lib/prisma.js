// A single shared database connection, reused by every route file.
// Each route does `const prisma = require("../lib/prisma")` instead of
// creating its own `new PrismaClient()` -- creating many separate clients
// would open many separate database connections for no reason.
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

module.exports = prisma;
