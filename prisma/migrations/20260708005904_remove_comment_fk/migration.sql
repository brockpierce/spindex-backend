-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ReviewComment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "reviewId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "parentId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReviewComment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ReviewComment_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "ReviewComment" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_ReviewComment" ("createdAt", "id", "parentId", "reviewId", "text", "userId") SELECT "createdAt", "id", "parentId", "reviewId", "text", "userId" FROM "ReviewComment";
DROP TABLE "ReviewComment";
ALTER TABLE "new_ReviewComment" RENAME TO "ReviewComment";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
