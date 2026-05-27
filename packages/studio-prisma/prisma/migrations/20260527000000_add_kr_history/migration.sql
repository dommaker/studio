-- B8: KRHistory table for OKR progress trend tracking
CREATE TABLE "kr_history" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "krId" TEXT NOT NULL,
    "okrId" TEXT NOT NULL,
    "value" REAL NOT NULL,
    "status" TEXT NOT NULL,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "kr_history_okrId_krId_idx" ON "kr_history"("okrId", "krId");
CREATE INDEX "kr_history_timestamp_idx" ON "kr_history"("timestamp");
