-- =============================================================================
-- listec_ro: read-only login + role membership + EXECUTE grants for the
-- worksheet report SPs and REFERENCES on the dbo.ClientCodeList TVP.
-- -----------------------------------------------------------------------------
-- Run this against the Noble SQL Server using a high-privilege login (e.g.
-- nobleone). Safe to re-run: every block is idempotent.
--
-- Convenience runner from Listec/integration/node-mssql/:
--     npm run grant:ro
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

-- Legacy SP: callers only need EXECUTE; the SP runs with dbo's rights.
IF OBJECT_ID(N'dbo.usp_listec_worksheet_report_json', N'P') IS NOT NULL
BEGIN
    GRANT EXECUTE ON dbo.usp_listec_worksheet_report_json TO listec_ro;
END
GO

-- 1) Read on every Noble table (and views) — covers tbl_med_mcc_unit_master
--    and any other ad-hoc SELECTs the listec service or BI tools issue.
IF NOT EXISTS (
    SELECT 1
    FROM sys.database_role_members rm
    JOIN sys.database_principals r ON r.principal_id = rm.role_principal_id
    JOIN sys.database_principals m ON m.principal_id = rm.member_principal_id
    WHERE r.name = N'db_datareader' AND m.name = N'listec_ro'
)
BEGIN
    ALTER ROLE db_datareader ADD MEMBER listec_ro;
END
GO

-- 2) EXECUTE on the new TVP-driven SP (guarded if not yet deployed).
IF OBJECT_ID(N'dbo.usp_listec_worksheet_report_by_codes', N'P') IS NOT NULL
BEGIN
    GRANT EXECUTE ON dbo.usp_listec_worksheet_report_by_codes TO listec_ro;
END
GO

-- 3) REFERENCES on the TVP so listec_ro can pass it as a parameter.
IF EXISTS (SELECT 1 FROM sys.types WHERE name = N'ClientCodeList' AND is_table_type = 1)
BEGIN
    GRANT REFERENCES ON TYPE::dbo.ClientCodeList TO listec_ro;
END
GO

-- 4) Verification — echoed in the deploy log for proof.
SELECT
    m.name AS member_name,
    r.name AS role_name
FROM sys.database_role_members rm
JOIN sys.database_principals r ON r.principal_id = rm.role_principal_id
JOIN sys.database_principals m ON m.principal_id = rm.member_principal_id
WHERE m.name = N'listec_ro';

SELECT
    p.permission_name,
    p.class_desc,
    OBJECT_SCHEMA_NAME(p.major_id) AS schema_name,
    OBJECT_NAME(p.major_id)        AS object_name
FROM sys.database_permissions p
JOIN sys.database_principals pr ON pr.principal_id = p.grantee_principal_id
WHERE pr.name = N'listec_ro' AND p.class_desc IN (N'OBJECT_OR_COLUMN', N'TYPE');
GO
