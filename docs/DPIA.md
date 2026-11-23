# Data protection impact assessment (draft)

> Status: **draft for completion by the institution's Data Protection Officer.** This is an engineer's account of data
> flows, risks and controls. It is not legal advice and must be reviewed against the applicable law before enrolment
> begins. Applicable law: **[name it — e.g. Ghana Data Protection Act 2012 (Act 843), GDPR, Kenya DPA 2019, Nigeria
> NDPA 2023, POPIA]**.

## 1. What is processed

| Data | Purpose | Storage | Retention |
| --- | --- | --- | --- |
| Face embedding (512 floats, L2-normalised) | Prove the person checking in is the enrolled student | `biometrics.face_templates`, separate schema/role | Until withdrawal/leaving + grace period (default 30 days) |
| Face images (camera frames) | Transient input to the model | **Never stored.** In memory in the API and face service only, wiped after the request | n/a |
| Liveness and quality scores | Decide whether a capture is trustworthy | `attendance_attempts` | 30 days for flagged evidence, longer in aggregate for records |
| Device fingerprint hash (UA family, platform, screen, random install id) | Prove the scan came from the student's own device | `devices.fingerprint_hash` (salted hash only) | Until device revoked or student leaves |
| WebAuthn public key | Verify device-bound assertions | `devices.public_key` | As above |
| Attendance records | The institution's academic record | `attendance_records` | Institution academic-records policy |
| Location (optional) | Geofence check when enabled | `attendance_attempts.geo_distance_m` (distance only, not coordinates) | 30 days |
| Consent records | Demonstrate lawful basis | `biometric_consents` | Life of the processing + audit period |
| Audit log | Accountability, dispute resolution | `audit_log`, append-only | Institutional audit period |

Raw GPS coordinates are not stored: the API stores the computed distance to the room.

## 2. Lawful basis and consent

- Explicit, versioned consent is collected before enrolment (`biometric_consents.notice_version`), and withdrawal is a
  first-class action (`DELETE /api/v1/biometrics`).
- **A non-biometric alternative exists**: a lecturer can mark a student present manually with a reason, and declining
  biometrics never blocks a student from class. Students who decline are not disadvantaged in the record.
- Withdrawal starts a grace period (default 30 days) after which the purge job deletes the template. The student can
  still be marked present manually.

## 3. Risks and controls

| Risk | Likelihood | Impact | Control |
| --- | --- | --- | --- |
| Template re-identification or misuse | Low | High | Embeddings only, isolated schema and DB role, at-rest encryption, access only on two code paths, audit trail |
| Coercion to enrol ("I'll be marked absent") | Medium | Medium | Manual alternative is advertised in the consent notice and enforceable by policy |
| False acceptance (friend passes as the student) | Low | High | Liveness + active challenge + similarity threshold tuned for FAR < 0.1%, review queue for borderline cases |
| False rejection (student cannot check in) | Medium | Medium | Manual fallback, quality feedback, device reset flow, appeals |
| Demographic bias in face matching | Medium | High | Evaluation script reporting per-group FAR/FRR; thresholds changed only after an evaluation run |
| Device sharing | Medium | Medium | One active device per student, `UNIQUE(session_id, device_id)`, reset requests approved by an admin after identity check |
| Insider tampering with records | Low | High | Reason required, override rows, append-only audit, no delete grant |
| Data breach of the API database | Low | High | Templates in a separate schema/role; password hashes are scrypt; session tokens hashed; secrets in a managed store |
| Over-retention | Medium | Medium | Scheduled purge job with recorded runs; retention periods are settings, not code |

## 4. Transparency

A student can download their attendance data and consent history at any time (`GET /api/v1/me/data-export`). The
export deliberately states that no images are stored and that embeddings are excluded from the download.

## 5. Open questions for the DPO

1. Which law applies, and what is the required notice content and retention period for biometric data?
2. Does the institution need a DPIA sign-off per faculty, or once centrally?
3. Is a Data Processing Agreement in place with the hosting provider (Neon) and the object-storage provider?
4. What is the academic-records retention period for `attendance_records` (independent of biometric retention)?
5. Who is the second approver for biometric purges, and is a two-admin rule sufficient or is a written request needed?
6. Is a biometric alternative required to be *offered by default* to all students, or only on request?
7. Is staff monitoring (e.g. lecturer usage reports) in scope of any employment-law obligations?
8. What is the breach-notification window and to whom?

## 6. Residual risk statement

With the controls above, residual risk is concentrated in two places: (a) threshold calibration for the institution's
population, which requires a consented evaluation set, and (b) the operational discipline of approving device resets
after a genuine identity check. Both are procedural, not technical, and both are documented in `RUNBOOK.md`.
