-- CreateTable
CREATE TABLE "TextPost" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TextPost_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "TextPost_userId_idx" ON "TextPost"("userId");

-- CreateIndex
CREATE INDEX "TextPost_createdAt_idx" ON "TextPost"("createdAt");
