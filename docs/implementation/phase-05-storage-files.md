# Phase 5: private encrypted attachments

## Architecture and compatibility

The browser reads, validates, and encrypts attachment bytes with a fresh random
AES-GCM-256 key and 96-bit IV for each file. The authenticated encrypted descriptor
travels inside the existing ratcheted chat message. FastAPI receives ciphertext only,
checks chat send permission before upload and chat membership before download, and
returns opaque `application/octet-stream` bytes with `private, no-store` and `nosniff`
headers. It never exposes a Storage URL or a filename/MIME field in object metadata.

Existing `media_objects` rows and foreign keys are unchanged. The model still contains
only the random media id, chat id, uploader id, opaque object key, ciphertext byte count,
and timestamp. There is no migration in this phase. Historical image descriptors with
`kind: "image"` and no descriptor version remain readable. New image descriptors add
`version: 2`; documents use `kind: "file", version: 2`. Both carry key, IV, MIME, name,
and plaintext size only inside the encrypted message payload. AES-GCM authentication
failure rejects corrupted ciphertext and wrong keys.

The backend keeps the same `put_encrypted_object`, `get_encrypted_object`, and
`delete_encrypted_object` interface. Local development uses MinIO. Staging/production
must use the Supabase S3 endpoint and server-only S3 keys. The adapter checks that the
configured bucket exists and never creates it automatically in Supabase. Buckets must
be private. Uploads set opaque content type and private no-store cache metadata. The
existing database commit rollback still attempts to delete an orphaned object, while
preserving the database error if cleanup fails.

### Historical object cutover

The application schema does not record which provider contains a historical blob.
Before switching an existing installation from MinIO to Supabase, copy the ciphertext
objects using their exact object keys into the private Supabase bucket. Verify object
counts and sampled keys/byte lengths before switching `STORAGE_BACKEND`. Do not decrypt
or rename them. Keep the old bucket intact until a separately reviewed retention plan
exists. No live object copy was performed for this phase. A fresh deployment starts
with an empty bucket and does not need this step.

## Dashboard setup

1. Create or select the Supabase project and open **Storage**.
2. Create a bucket named in `MEDIA_BUCKET`; leave **Public bucket** disabled. The
   application does not create this bucket or change its access policy.
3. Open **Storage → Configuration → S3** (or the current S3 connection settings),
   enable the S3 protocol, and generate an access-key/secret-key pair for server use.
   These keys have broad storage access and bypass Storage RLS; keep them only in the
   backend deployment secret manager. Do not put them in frontend/Vite settings.
4. Copy the exact endpoint and region displayed by the dashboard. The endpoint format
   is `https://<project-ref>.storage.supabase.co/storage/v1/s3` and requests use AWS
   Signature Version 4 with path-style bucket addressing.
5. Configure the backend variables from `backend/.env.example`: `STORAGE_BACKEND=supabase`,
   `SUPABASE_STORAGE_ENDPOINT`, `SUPABASE_STORAGE_REGION`,
   `SUPABASE_STORAGE_ACCESS_KEY`, `SUPABASE_STORAGE_SECRET_KEY`, and `MEDIA_BUCKET`.
   Keep `APP_ENV=staging` or `production` and apply the normal required JWT, database,
   Redis, Supabase Auth, CORS and TLS settings as well.
6. Deploy only after the backend can reach the endpoint and bucket. Test an authorized
   member upload/download, a non-member denial, and an object copy/cutover where
   historical MinIO data exists.

The official Supabase docs confirm `HeadBucket`, `PutObject`, `GetObject`, and
`DeleteObject` support, AWS SigV4 authentication, and the direct `*.storage.supabase.co`
endpoint. S3 object versioning is not supported. See [S3 compatibility](https://supabase.com/docs/guides/storage/s3/compatibility),
[S3 authentication](https://supabase.com/docs/guides/storage/s3/authentication), and
[S3 uploads](https://supabase.com/docs/guides/storage/uploads/s3-uploads).

## File policy and limits

- Maximum plaintext attachment size: **8 MiB** by default. Keep backend `MEDIA_MAX_BYTES`
  and browser-safe `VITE_MEDIA_MAX_BYTES` aligned when changing the limit. The backend accepts at most 8 MiB plus
  64 bytes of ciphertext overhead. Files are rejected before browser encryption when
  oversized; browser processing currently reads the file into memory, so this limit
  intentionally stays small. The backend reads request files in bounded 64 KiB chunks
  and caps retained bytes. Reverse proxies should also enforce a request-body limit.
- Supported images remain JPEG, PNG, WebP, and GIF. Images retain the existing browser
  decode/downscale path; GIF remains unmodified. The uploaded object itself is always
  ciphertext.
- Supported documents are PDF (checked for the `%PDF-` signature) and UTF-8 plain text
  (NUL-free). Documents are downloaded to the user's device and are never embedded,
  rendered as HTML, or processed by the server. Office archives, HTML, SVG, executables,
  and other types are rejected for now.
- The filename is sanitized for display/download. MIME and filename are only in the
  encrypted descriptor; they are not trusted by backend routes or used to serve inline
  content. A receiver can still download malicious content deliberately sent by a
  contact and should open files with normal operating-system precautions.
- Single-request uploads are used. Multipart/resumable uploads and very large files are
  not implemented or promised. No server-side thumbnails/previews or automatic
  retention cleanup were added.

## Migration and rollback

No Alembic revision is required because existing table columns already represent the
opaque storage objects and no filename/MIME/key is added to the database. Review the
configuration and run the backend migration/model check to confirm the migration chain
is still aligned. Switching provider is a configuration change plus an operator-managed
ciphertext copy, not a destructive table migration. Rollback means switching the
backend configuration to the retained MinIO bucket after verifying the corresponding
object keys remain present. Do not delete either bucket during rollback.

## Validation and known limits

Validation results are recorded in `IMPLEMENTATION_STATUS.md`. Automated tests use
fake S3 clients and local cryptography; they do not verify live Supabase credentials,
bucket privacy settings, historical-object copy, MinIO availability, or deployment
network policies. A provider-backed browser test remains required before production.
