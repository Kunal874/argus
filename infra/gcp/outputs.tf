output "api_uri" { value = google_cloud_run_v2_service.api.uri }
output "data_bucket" { value = google_storage_bucket.data.name }
output "database_connection_name" { value = google_sql_database_instance.postgres.connection_name sensitive = true }
