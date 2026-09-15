-- =============================================================================
-- Noble.dbo.usp_listec_worksheet_summary
-- -----------------------------------------------------------------------------
-- The counting procedure behind the Tracer's package tiles.
--
-- Why it exists: usp_listec_worksheet_report_json builds, for EVERY sample, a
-- JSON array of all its test results (a correlated subquery over three tables
-- with a sort and FOR JSON PATH) and pages the result with OFFSET/FETCH. The
-- Tracer then walked that JSON in Node only to count result rows per test
-- code. Measured on the largest unit for one month: 93% of the bytes were the
-- JSON nobody read, and OFFSET made each page re-scan the ones before it
-- (page 1 = 0.6 s, page 50 = 13 s, ~65 pages).
--
-- This procedure returns exactly what the counts need, in one pass:
--   result set 1 — one row per sample: sid, test_names_csv, client_code
--                  (bracket-label parsing and geography bucketing in Node)
--   result set 2 — one row per (test_code, sid) for the requested codes, with
--                  the number of matching result rows (the per-mode buckets)
-- No JSON, no paging.
--
-- Filter semantics are copied verbatim from the two report procedures:
--   @client_codes  empty  -> no client filter (as usp_..._report_json)
--                  filled -> exact MCCUnitCode match (as usp_..._by_codes)
--   @bu_via_client 1      -> BU matches the sample's BU OR the client's BU
--                            (usp_..._report_json semantics)
--                  0      -> BU matches the sample's BU only
--                            (usp_..._by_codes semantics)
--
-- Read-only: SELECT only. Idempotent: CREATE OR ALTER. Additive: nothing
-- existing is altered; DROP PROCEDURE reverts it.
-- =============================================================================
SET ANSI_NULLS ON;
GO
SET QUOTED_IDENTIFIER ON;
GO

CREATE OR ALTER PROCEDURE dbo.usp_listec_worksheet_summary
    @from_date              DATE,
    @to_date                DATE,
    @bucket_test_codes      dbo.TestCodeList READONLY,
    @client_codes           dbo.ClientCodeList READONLY,
    @from_hour              TINYINT       = 0,
    @to_hour                TINYINT       = 24,
    @patient_name           NVARCHAR(200) = NULL,
    @status_id              INT           = NULL,
    @client_code            NVARCHAR(50)  = NULL,
    @sid                    NVARCHAR(50)  = NULL,
    @department_id          INT           = NULL,
    @business_unit_id       INT           = NULL,
    @bu_via_client          BIT           = 1,
    @test_code              NVARCHAR(50)  = NULL,
    @pid                    INT           = NULL,
    @include_unauthorized   BIT           = 1
AS
BEGIN
    SET NOCOUNT ON;
    SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;

    DECLARE @from DATETIME =
        DATEADD(HOUR, @from_hour, CAST(@from_date AS DATETIME));

    DECLARE @to DATETIME =
        CASE
            WHEN @to_hour >= 24 THEN
                DATEADD(SECOND, -1, DATEADD(DAY, 1, CAST(@to_date AS DATETIME)))
            ELSE
                DATEADD(HOUR, @to_hour, CAST(@to_date AS DATETIME))
        END;

    DECLARE @codeCount INT = (SELECT COUNT(*) FROM @client_codes);

    -- Materialise the sample window once; both result sets read from it.
    SELECT
        S.vailid        AS sid,
        S.testnames     AS test_names_csv,
        U.MCCUnitCode   AS client_code
    INTO #H
    FROM dbo.tbl_med_mcc_patient_samples S
    INNER JOIN dbo.tbl_med_mcc_patient_master P
        ON S.patient_id = P.id
    INNER JOIN dbo.tbl_med_mcc_unit_master U
        ON P.mcc_code = U.id
    WHERE S.modifieddate BETWEEN @from AND @to
      AND S.sample_status > 1
      AND (@status_id IS NULL OR S.sample_status = @status_id)
      AND (@pid IS NULL OR P.id = @pid)
      AND (
            @sid IS NULL
            OR S.vailid LIKE '%' + @sid + '%'
            OR P.bill_number LIKE '%' + @sid + '%'
          )
      AND (
            @client_code IS NULL
            OR U.MCCUnitCode LIKE '%' + @client_code + '%'
          )
      AND (
            @codeCount = 0
            OR EXISTS (
                SELECT 1 FROM @client_codes c
                WHERE c.code = U.MCCUnitCode
            )
          )
      AND (
            @patient_name IS NULL
            OR P.name LIKE '%' + @patient_name + '%'
            OR P.MRNID = @patient_name
          )
      AND (
            @business_unit_id IS NULL
            OR S.business_unit_id = @business_unit_id
            OR (@bu_via_client = 1 AND U.BusinessUnitCode = @business_unit_id)
          )
      AND (
            @department_id IS NULL
            OR EXISTS (
                SELECT 1
                FROM dbo.tbl_med_mcc_patient_test_result r
                INNER JOIN dbo.tbl_med_test_master m ON r.testid = m.id
                WHERE r.vailid = S.vailid
                  AND m.DepartmentId = @department_id
                  AND r.testtype IN (N'Test', N'Head')
            )
          )
      AND (
            @test_code IS NULL
            OR S.testcodes LIKE '%' + @test_code + '%'
            OR EXISTS (
                SELECT 1
                FROM dbo.tbl_med_mcc_patient_test_result r
                WHERE r.vailid = S.vailid
                  AND (
                        r.testcode = @test_code
                        OR r.testname LIKE '%' + @test_code + '%'
                      )
            )
          );

    -- Result set 1: the samples.
    SELECT sid, test_names_csv, client_code
    FROM #H;

    -- Result set 2: per (test_code, sid) result-row counts for the requested
    -- codes. Same rows the JSON path exposed — every result row of the sample
    -- whose code matches, case-insensitively, honouring @include_unauthorized.
    SELECT
        r.testcode  AS test_code,
        r.vailid    AS sid,
        COUNT(*)    AS result_rows
    FROM #H h
    INNER JOIN dbo.tbl_med_mcc_patient_test_result r
        ON r.vailid = h.sid
    INNER JOIN @bucket_test_codes b
        ON UPPER(r.testcode) = UPPER(b.code)
    WHERE (@include_unauthorized = 1 OR r.auth = 1)
    GROUP BY r.testcode, r.vailid;

    DROP TABLE #H;
END
GO

IF EXISTS (SELECT 1 FROM sys.database_principals WHERE name = 'listec_ro')
BEGIN
    GRANT EXECUTE ON dbo.usp_listec_worksheet_summary TO listec_ro;
END
GO
