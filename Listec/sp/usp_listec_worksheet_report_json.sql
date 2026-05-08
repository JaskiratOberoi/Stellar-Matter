-- =============================================================================
-- Noble.dbo.usp_listec_worksheet_report_json
-- -----------------------------------------------------------------------------
-- Purpose: Return one row per sample (SID / vailid) with a JSON array of all
--          test results for that sample. Filters mirror Sample Worksheet UI.
-- Idempotent: CREATE OR ALTER (SQL Server 2016 SP1+ / 2017+ / 2019+).
-- Read-only: SELECT only.
--
-- Deploy (example):
--   sqlcmd -S YourServer,1433 -d Noble -U sa -i usp_listec_worksheet_report_json.sql
-- =============================================================================
SET ANSI_NULLS ON;
GO
SET QUOTED_IDENTIFIER ON;
GO

CREATE OR ALTER PROCEDURE dbo.usp_listec_worksheet_report_json
    @from_date              DATE,
    @to_date                DATE,
    @from_hour              TINYINT       = 0,      -- 0..23
    @to_hour                TINYINT       = 24,     -- 1..23 or 24 = end of @to_date day (23:59:59)
    @patient_name           NVARCHAR(200) = NULL,   -- NULL = all; LIKE on name + exact MRNID
    @status_id              INT           = NULL,   -- NULL = all; sample_status 1..10
    @client_code            NVARCHAR(50)  = NULL,   -- NULL = all; LIKE on MCCUnitCode
    @sid                    NVARCHAR(50)  = NULL,   -- NULL = all; vailid or bill_number LIKE
    @department_id          INT           = NULL,   -- NULL = all; tbl_med_test_master.DepartmentId
    @business_unit_id       INT           = NULL,   -- NULL = all; S.business_unit_id
    @test_code              NVARCHAR(50)  = NULL,   -- NULL = all; cached testcodes or result rows
    @pid                    INT           = NULL,   -- NULL = all; P.id
    @tat_only               BIT           = 0,      -- Reserved: UI parity with legacy SP (currently no filter logic)
    @include_unauthorized   BIT           = 1,      -- 0 = only rows where r.auth = 1
    @page                   INT           = 1,
    @page_size              INT           = 500     -- clamped 1..5000
AS
BEGIN
    SET NOCOUNT ON;
    SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;

    -- @tat_only: legacy UI exposes a TAT checkbox but underlying SP never used it.
    -- Keep parameter for forward compatibility (e.g. WHERE EXISTS overdue TAT).

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
                @client_code IS NULL
                OR U.MCCUnitCode LIKE '%' + @client_code + '%'
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
