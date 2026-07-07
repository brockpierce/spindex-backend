-- CreateTable
CREATE TABLE "AlbumTag" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "albumId" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AlbumTag_albumId_fkey" FOREIGN KEY ("albumId") REFERENCES "Album" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "AlbumTag_tag_idx" ON "AlbumTag"("tag");

-- CreateIndex
CREATE UNIQUE INDEX "AlbumTag_albumId_tag_key" ON "AlbumTag"("albumId", "tag");
