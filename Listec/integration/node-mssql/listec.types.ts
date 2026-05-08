/**
 * Types aligned with Noble.dbo.usp_listec_worksheet_report_json
 * (paste into your Node.js / TypeScript app — or import from this path).
 */

/** Query parameters passed to the stored procedure */
export interface WorksheetReportFilters {
  fromDate: string; // 'YYYY-MM-DD'
  toDate: string;
  fromHour?: number; // 0..23, default 0
  toHour?: number; // 1..23 or 24 = end of toDate, default 24
  patientName?: string | null;
  statusId?: number | null; // sample_status id, or null = all
  clientCode?: string | null; // partial match on MCCUnitCode
  sid?: string | null;
  departmentId?: number | null;
  businessUnitId?: number | null;
  testCode?: string | null;
  pid?: number | null;
  tatOnly?: boolean; // reserved / no-op in SP today
  includeUnauthorized?: boolean; // default true
  page?: number; // 1-based
  pageSize?: number; // clamped 1..5000 server-side
}

/** One element inside results_json */
export interface TestResult {
  result_id: number;
  test_code: string | null;
  test_name: string | null;
  test_type: string | null;
  value: string | null;
  unit: string | null;
  normal_range: string | null;
  abnormal: boolean;
  authorized: boolean;
  comments: string | null;
  updated_at: string | null; // ISO string from SQL datetime
  department_code: string | null;
  department_name: string | null;
}

/** One row returned by the SP (after parsing JSON) */
export interface WorksheetReportRow {
  client_code: string | null;
  business_unit: string | null;
  pid: number;
  patient_name: string | null;
  sex: string | null;
  age: number | null;
  age_unit: string | null;
  sid: string;
  sample_drawn: string | null;
  regd_at: string | null;
  last_modified_at: string | null;
  status_code: number | null;
  status: string | null;
  test_names_csv: string | null;
  order_number: string | null;
  bill_number: string | null;
  sample_comments: string | null;
  clinical_history: string | null;
  tat: string | null;
  results: TestResult[];
}
