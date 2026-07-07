-- CreateTable
CREATE TABLE "ArtistAlias" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "artistName" TEXT NOT NULL,
    "alias" TEXT NOT NULL,
    "locale" TEXT,
    "musicbrainzArtistId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "ArtistAlias_artistName_idx" ON "ArtistAlias"("artistName");

-- CreateIndex
CREATE INDEX "ArtistAlias_alias_idx" ON "ArtistAlias"("alias");

-- CreateIndex
CREATE UNIQUE INDEX "ArtistAlias_musicbrainzArtistId_alias_key" ON "ArtistAlias"("musicbrainzArtistId", "alias");
