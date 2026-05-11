-- =============================================================================
-- Noble.dbo.ClientCodeList — TVP for usp_listec_worksheet_report_by_codes.
-- -----------------------------------------------------------------------------
-- Phase 12: chip -> client_codes -> SP filter pipeline. The api-matter Tracer
-- resolves a city/state chip into a list of MCCUnitCode values via Postgres
-- and passes it into MSSQL through this TVP, so the SP only returns SIDs
-- owned by the resolved codes (instead of the prior full-window scan + JS
-- post-bucketing).
--
-- Idempotent: SQL Server has no `CREATE TYPE IF NOT EXISTS`, so we guard via
-- sys.types lookup. Dropping the type would fail if the SP that depends on
-- it exists, which is intentional — schema migrations are explicit.
-- =============================================================================
SET ANSI_NULLS ON;
GO
SET QUOTED_IDENTIFIER ON;
GO

IF NOT EXISTS (
    SELECT 1
    FROM sys.types t
    JOIN sys.schemas s ON s.schema_id = t.schema_id
    WHERE s.name = 'dbo' AND t.name = 'ClientCodeList'
)
BEGIN
    CREATE TYPE dbo.ClientCodeList AS TABLE (
        code NVARCHAR(50) NOT NULL PRIMARY KEY
    );
END
GO

-- Best-effort grant for the read-only API user. Ignored if the principal
-- doesn't exist in this environment (deploy with sqlcmd will error which is
-- desirable in prod; comment out for local sandboxes without listec_ro).
IF EXISTS (SELECT 1 FROM sys.database_principals WHERE name = 'listec_ro')
BEGIN
    GRANT EXEC, REFERENCES ON TYPE::dbo.ClientCodeList TO listec_ro;
END
GO
