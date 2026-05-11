-- =============================================================================
-- Noble.dbo.usp_listec_worksheet_report_by_codes
-- -----------------------------------------------------------------------------
-- Sibling SP to usp_listec_worksheet_report_json. Identical row shape and
-- filter semantics, except @client_code (NVARCHAR LIKE) is replaced with
-- @client_codes (TVP, exact match against U.MCCUnitCode).
--
-- Phase 12 (Tracer chips -> client_codes -> SP filter): api-matter resolves
-- the Tracer Region chip selection into a list of MCCUnitCode values via
-- Postgres `client_locations` and passes it here so MSSQL only returns SIDs
-- owned by those codes. An empty TVP behaves like NULL @client_code in the
-- old SP — i.e. no filter — which keeps callers with optional code lists
-- happy.
--
-- Read-only: SELECT only. Idempotent: CREATE OR ALTER.
-- =============================================================================
SET ANSI_NULLS ON;
GO
SET QUOTED_IDENTIFIER ON;
GO

CREATE OR ALTER PROCEDURE dbo.usp_listec_worksheet_report_by_codes
    @from_date              DATE,
    @to_date                DATE,
    @client_codes           dbo.ClientCodeList READONLY,
    @from_hour              TINYINT       = 0,
    @to_hour                TINYINT       = 24,
    @patient_name           NVARCHAR(200) = NULL,
    @status_id              INT           = NULL,
    @sid                    NVARCHAR(50)  = NULL,
    @department_id          INT           = NULL,
    @business_unit_id       INT           = NULL,
    @test_code              NVARCHAR(50)  = NULL,
    @pid                    INT           = NULL,
    @tat_only               BIT           = 0,
    @include_unauthorized   BIT           = 1,
    @page                   INT           = 1,
    @page_size              INT           = 500
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

    DECLARE @pageSafe INT = CASE WHEN @page < 1 THEN 1 ELSE @page END;
    DECLARE @size INT =
        CASE
            WHEN @page_size < 1 THEN 500
            WHEN @page_size > 5000 THEN 5000
            ELSE @page_size
        END;
    DECLARE @offset INT = (@pageSafe - 1) * @size;

    -- Empty TVP -> behave like the old @client_code IS NULL path (no filter).
    -- Cache the count once so the WHERE clause is a constant predicate per row
    -- (the optimiser will fold it; cheaper than running EXISTS on every row
    -- when the TVP is empty).
    DECLARE @codeCount INT = (SELECT COUNT(*) FROM @client_codes);

    ;WITH H AS (
        SELECT
            P.id AS pid,
            U.MCCUnitCode AS client_code,
            BU.BusinessUnitCode AS business_unit,
            P.name AS patient_name,
            CASE P.gender WHEN 1 THEN 'Male' ELSE 'Female' END AS sex,
            P.age,
            CASE P.age_type
                WHEN 1 THEN 'Year(s)'
                WHEN 2 THEN 'Month(s)'
                WHEN 3 THEN 'Day(s)'
                ELSE 'Unknown'
            END AS age_unit,
            S.vailid AS sid,
            P.sample_time AS sample_drawn,
            S.modifieddate AS regd_at,
            S.lastmodified_date AS last_modified_at,
            STAT.id AS status_code,
            STAT.status AS status,
            S.testnames AS test_names_csv,
            P.order_number,
            P.bill_number,
            S.Sample_Comments AS sample_comments,
            S.Sample_ClinicalHistory AS clinical_history
        FROM dbo.tbl_med_mcc_patient_samples S
        INNER JOIN dbo.tbl_med_mcc_patient_master P
            ON S.patient_id = P.id
        INNER JOIN dbo.tbl_med_mcc_unit_master U
            ON P.mcc_code = U.id
        LEFT JOIN dbo.tbl_med_business_unit_master BU
            ON BU.id = S.business_unit_id
        LEFT JOIN dbo.tbl_med_mcc_patient_samples_status_master STAT
            ON STAT.id = S.sample_status
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
              )
    )
    SELECT
        H.client_code,
        H.business_unit,
        H.pid,
        H.patient_name,
        H.sex,
        H.age,
        H.age_unit,
        H.sid,
        H.sample_drawn,
        H.regd_at,
        H.last_modified_at,
        H.status_code,
        H.status,
        H.test_names_csv,
        H.order_number,
        H.bill_number,
        H.sample_comments,
        H.clinical_history,
        (
            SELECT MAX(r2.updateddate)
            FROM dbo.tbl_med_mcc_patient_test_result r2
            WHERE r2.vailid = H.sid
        ) AS tat,
        (
            SELECT
                r.id AS result_id,
                r.testcode AS test_code,
                r.testname AS test_name,
                r.testtype AS test_type,
                r.value,
                r.testunit AS unit,
                r.testnormal_range AS normal_range,
                CONVERT(bit, ISNULL(r.abnormal, 0)) AS abnormal,
                CONVERT(bit, ISNULL(r.auth, 0)) AS authorized,
                r.comments,
                r.updateddate AS updated_at,
                d.Code AS department_code,
                d.Name AS department_name
            FROM dbo.tbl_med_mcc_patient_test_result r
            LEFT JOIN dbo.tbl_med_test_master m ON r.testid = m.id
            LEFT JOIN dbo.tbl_med_department_master d ON m.DepartmentId = d.id
            WHERE r.vailid = H.sid
              AND (@include_unauthorized = 1 OR r.auth = 1)
            ORDER BY
                CASE r.testtype
                    WHEN N'Head' THEN 0
                    WHEN N'Profile' THEN 1
                    WHEN N'Test' THEN 2
                    ELSE 3
                END,
                r.id
            FOR JSON PATH
        ) AS results_json
    FROM H
    ORDER BY H.regd_at DESC
    OFFSET @offset ROWS FETCH NEXT @size ROWS ONLY;
END
GO

-- Best-effort grant for the read-only API user (parity with the old SP).
IF EXISTS (SELECT 1 FROM sys.database_principals WHERE name = 'listec_ro')
BEGIN
    GRANT EXECUTE ON dbo.usp_listec_worksheet_report_by_codes TO listec_ro;
END
GO
