// OAuth scopes. Everything here is read-only except where noted.
//
//  logging.read  – read + live-tail logs (free)
//  run.readonly  – read Cloud Run service status
//
// Cloud Monitoring is deliberately NOT here: its API is billed per read, so the
// app never uses it (the read-only guard blocks monitoring.googleapis.com too).
export const READ_SCOPES = [
  'https://www.googleapis.com/auth/logging.read',
  'https://www.googleapis.com/auth/run.readonly',
];

// The Costs page: reading the billing-export table in BigQuery. Read-only, and the
// guard lets only the free table preview (tabledata.list) and its metadata through,
// never a query or a job, so it can't run up a bill either.
export const BILLING_SCOPES = ['https://www.googleapis.com/auth/bigquery.readonly'];

// For the APIs that have no read-only scope:
//   • the Kubernetes API of the cluster. GKE turns away tokens that only carry
//     narrow scopes (HTTP 401), so it gets the same scopes kubectl/gcloud use.
//   • the cluster's endpoint + CA certificate (container.googleapis.com)
//   • Cloud SQL instance status and recent operations (sqladmin.googleapis.com)
// The token still can't change anything: the service account only holds Viewer
// roles (IAM decides, not the scope), and the guard only lets exact GET paths out.
export const PLATFORM_SCOPES = ['https://www.googleapis.com/auth/cloud-platform', 'https://www.googleapis.com/auth/userinfo.email'];
