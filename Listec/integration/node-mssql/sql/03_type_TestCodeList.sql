-- =============================================================================
-- Noble.dbo.TestCodeList — TVP for usp_listec_worksheet_summary.
-- -----------------------------------------------------------------------------
-- The Tracer derives every specialty mode (urine / EDTA / citrate / flouride /
-- LBC / S.Hep / L.Hep) from one SP call per business unit by bucketing SIDs
-- per test code. This type carries that code list into MSSQL so the bucketing
-- happens in the database instead of shipping every result row to Node.
--
-- Idempotent: guarded via sys.types (SQL Server has no CREATE TYPE IF NOT
-- EXISTS). Dropping the type fails while the SP depends on it — intentional.
-- =============================================================================
SET ANSI_NULLS ON;
GO
SET QUOTED_IDENTIFIER ON;
GO

IF NOT EXISTS (
    SELECT 1
    FROM sys.types t
    JOIN sys.schemas s ON s.schema_id = t.schema_id
    WHERE s.name = 'dbo' AND t.name = 'TestCodeList'
)
BEGIN
    CREATE TYPE dbo.TestCodeList AS TABLE (
        code NVARCHAR(50) NOT NULL PRIMARY KEY
    );
END
GO

IF EXISTS (SELECT 1 FROM sys.database_principals WHERE name = 'listec_ro')
BEGIN
    GRANT EXEC, REFERENCES ON TYPE::dbo.TestCodeList TO listec_ro;
END
GO
