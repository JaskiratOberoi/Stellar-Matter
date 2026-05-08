-- =============================================================================
-- Least-privilege login for calling dbo.usp_listec_worksheet_report_json only
-- -----------------------------------------------------------------------------
-- The SP is owned by dbo; callers need only EXECUTE on that object — NOT
-- db_datareader — unless you also run ad-hoc SELECTs with the same login.
--
-- 1. Replace <STRONG_PASSWORD_HERE> before running.
-- 2. Run on the SQL Server instance (master + Noble).
-- =============================================================================

USE master;
GO

IF NOT EXISTS (SELECT 1 FROM sys.server_principals WHERE name = N'listec_ro')
BEGIN
    CREATE LOGIN listec_ro
        WITH PASSWORD = N'Stellar@101196',
             CHECK_POLICY = ON,
             DEFAULT_DATABASE = Noble;
END
GO

USE Noble;
GO

IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'listec_ro')
BEGIN
    CREATE USER listec_ro FOR LOGIN listec_ro;
END
GO

-- Minimum required: execute the reporting SP only (runs with dbo's rights inside the SP)
GRANT EXECUTE ON dbo.usp_listec_worksheet_report_json TO listec_ro;
GO

-- OPTIONAL: uncomment if this login also needs raw table access (BI tools, ad-hoc SQL)
-- ALTER ROLE db_datareader ADD MEMBER listec_ro;
-- GO
