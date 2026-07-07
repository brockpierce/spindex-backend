-- CreateTable
CREATE TABLE "AlbumMix" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AlbumMix_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AlbumMixItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "mixId" TEXT NOT NULL,
    "albumId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "note" TEXT,
    CONSTRAINT "AlbumMixItem_mixId_fkey" FOREIGN KEY ("mixId") REFERENCES "AlbumMix" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AlbumMixItem_albumId_fkey" FOREIGN KEY ("albumId") REFERENCES "Album" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "AlbumMixItem_mixId_albumId_key" ON "AlbumMixItem"("mixId", "albumId");
