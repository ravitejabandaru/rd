# Salesforce Post-Deployment (PD) Steps Automation — Specification

| | |
|---|---|
| **Document type** | Product & technical specification |
| **Status** | Draft v1.0 |
| **Target stack** | TypeScript Salesforce CLI (`sf`) plugin, CloudBees / Jenkins (custom Jenkinsfile) |
| **Working name** | `sf-pd` plugin (command topic: `sf pd`) |

---

## 1. Background & Problem

Salesforce metadata is deployed automatically through the Metadata API (`sf project deploy`) in our CloudBees/Jenkins pipeline. However, every release also has **pre- and post-deployment (PD) steps** that are currently documented in a release document (table: No / Jira ticket / Task description / PRE step / POST step) and **executed manually** in each environment.

Typical manual PD steps today:

- Updating records in custom configuration objects (e.g. `ICB_GraphQL_Query__c`, `DYN_Permission_Set_Mapping__c`)
- Appending values to semicolon-separated fields
- Deleting / re-inserting configuration records via anonymous Apex in Developer Console
- Changing the owner of a specific record (one-off production fixes)
- Adding roles/users to public groups
- Setup UI changes (In-App Guidance prompt activation, CTI adapter configuration)
- Steps that are actually metadata but were done manually (permission set changes, record type picklist values, flow activation)

**Problems:** manual effort, human error, no audit trail, no record of which steps ran in which org, steps get missed or run twice, hardcoded record Ids that only work in one org, Prod access needed by individuals.

## 2. Goals & Non-Goals

### Goals
1. Developers define PD steps **declaratively (YAML)** in the same Git branch/PR as their code.
2. PD steps are **grouped by release**, with **one file per Jira story** inside a release.
3. A runner executes **pending** steps against a target org from Jenkins, after metadata deployment.
4. Every step is **tracked per org** — never executed twice, status visible per release.
5. **Safety**: schema validation, dry-run/plan with record counts and diffs, backups before mutation, guardrails (`maxRecords`, `expectRecords`, `where`), Prod approval gate.
6. Support selecting records **by SOQL query or by record Ids (per environment)**.
7. Support **manual steps** that pause the pipeline until a human confirms.
8. Produce a **plan report** and a **run report** (HTML + JSON) archived per Jenkins build.

### Non-Goals (v1)
- Replacing metadata deployment (anything deployable via Metadata API must be deployed as metadata — see §13).
- A web UI (Jenkins + reports are the UI in v1).
- Automatic rollback of `delete`/`insert` (backups are taken; restore is a later phase).
- Cross-org data migration tooling (use SFDMU if needed).

## 3. Users & Responsibilities

| Role | Responsibility |
|---|---|
| **Developer** | Writes the story YAML (+ CSV/data files) in the feature branch; runs `validate` and `plan`/`run --dry-run` against own sandbox |
| **PR reviewer / PD champion** | Reviews the PD file like code (correct query, idempotent, backup on, guards present) |
| **Release manager** | Owns `release.yaml` (ordering, pre-checks); reviews `plan` report; approves PROD run in Jenkins |
| **Platform/DevOps owner** | Maintains the plugin, schema, `pd.config.yaml`, Jenkins stages |

## 4. High-Level Architecture

```
Git repo (feature branch / release branch)
 ├─ force-app/                 → deployed by `sf project deploy` (existing)
 ├─ pd-steps/<release>/…       → PD step definitions (new)
 └─ pd.config.yaml             → environment map (new)

Jenkins (CloudBees) pipeline
  Deploy Metadata → PD Validate → PD Plan → [PROD: Approval] → PD Run → (Manual step loop) → Archive reports/backups

sf pd plugin (TypeScript)
  ├─ Loader      : reads release.yaml + story files, validates with JSON Schema
  ├─ Resolver    : resolves env, template functions, record selection (query / ids)
  ├─ Planner     : computes pending steps, record counts, sample diffs, guard checks
  ├─ Executor    : REST (sObject Collections) / Bulk API 2.0 / Tooling / Apex
  ├─ Tracker     : reads/writes PD_Step_Execution__c in target org
  ├─ Backup      : snapshots affected records before mutation
  └─ Reporter    : JSON + HTML plan/run reports
```

## 5. Technology Stack

- **Language/runtime:** TypeScript, Node.js 20 LTS
- **Plugin framework:** `@salesforce/sf-plugins-core` (oclif), scaffolded via `sf dev generate plugin`
- **Salesforce access:** `@salesforce/core` (`Org`, `Connection` — jsforce under the hood); Bulk API 2.0 via `connection.bulk2`
- **YAML:** `yaml`; **Schema validation:** `ajv` (JSON Schema draft 2020-12)
- **CSV:** `csv-parse`, `csv-stringify`
- **Reports:** JSON + simple HTML template (no framework)
- **Tests:** mocha + chai + sinon (sf plugin standard), `@salesforce/core/testSetup` for mocked orgs
- **Auth:** reuses `sf` org aliases. In Jenkins: JWT bearer flow via Connected App (`sf org login jwt`), no passwords.

## 6. Repository Layout

```
pd.config.yaml
pd-steps/
  schema/pd-step.schema.json          # published JSON Schema (VS Code autocomplete)
  R2026.11/
    release.yaml
    DYN-742926_fraud-fincrime-permissions.yaml
    DYN-612109_generic-role-mappings.yaml
    data/
      DYN-612109_role_mappings.csv
    queries/
      getEletterPlaceholders.graphql
  R2026.12/
    release.yaml
    ...
  hotfix/
    HF-2026.11.1/
      release.yaml
      ...
  archive/                            # releases already in PROD (ignored by runner)
pd-backups/                           # generated, git-ignored, archived by Jenkins
pd-reports/                           # generated, git-ignored, archived by Jenkins
```

**Naming:** story file = `<JIRA-KEY>_<short-kebab-description>.yaml`. Data files are prefixed with the Jira key.

## 7. Configuration — `pd.config.yaml`

Maps orgs to environment names **by Org Id** (not alias — prevents applying PROD Ids to a wrong org because of a misconfigured alias).

```yaml
environments:
  DEV:
    orgId: 00D000000000001
    usernameSuffix: .dev          # appended by user() for sandbox usernames
  QA:
    orgId: 00D000000000002
    usernameSuffix: .qa
  UAT:
    orgId: 00D000000000003
    usernameSuffix: .uat
  PROD:
    orgId: 00D000000000004
    usernameSuffix: ""
    requireApproval: true          # run refuses without --approved flag (set by Jenkins after input step)

variables:                         # per-env values usable as {{ var('NAME') }}
  INTEGRATION_ENDPOINT:
    DEV: https://dev.example.com
    PROD: https://api.example.com

defaults:
  backup: true
  maxRecords: 10000
  stopOnFailure: true
  bulkThreshold: 2000              # > this many records → Bulk API 2.0, else REST sObject Collections

releaseOrdering: strict            # strict | warn — block running a release if an older release has pending steps
```

If the target org's Org Id is not in `environments`, the runner **fails**.

## 8. Release File — `release.yaml`

```yaml
release: R2026.11
targetDate: 2026-11-15
description: November release
order:                    # optional; story keys in execution order. Unlisted stories run after, alphabetically
  - DYN-612109
  - DYN-742926
preSteps:                 # run BEFORE metadata deployment (optional; executed by `sf pd run --phase pre`)
  - id: activate-deployment-message
    type: manual
    instructions: >
      Setup → In-App Guidance → "DYN Deployment Notification" → Reset Metrics → Activate
postChecks:               # run after all story steps
  - id: no-processing-batch-jobs
    type: assert
    query: SELECT COUNT() FROM AsyncApexJob WHERE Status = 'Processing' AND JobType = 'BatchApex'
    expect: 0
finalSteps:
  - id: deactivate-deployment-message
    type: manual
    instructions: Setup → In-App Guidance → "DYN Deployment Notification" → Deactivate
```

Story files can also declare `phase: pre` on individual steps (default `post`).

## 9. Story File Format

```yaml
story: DYN-742926                 # required, must match filename prefix
owner: developer.name             # required
description: Fraud & FinCrime channel role visibility
dependsOn: [DYN-612109]           # optional, other stories in same release
steps:
  - id: append-permsets-fraud-fincrime   # required, unique within story, kebab-case
    type: update
    description: ...
    # ... type-specific fields
```

### 9.1 Common step fields

| Field | Type | Default | Description |
|---|---|---|---|
| `id` | string | — | Required. Unique within the story. **Must not change after the step has run anywhere.** |
| `type` | enum | — | Required. See §9.3 |
| `description` | string | — | Human-readable purpose (shown in reports) |
| `phase` | `pre` \| `post` | `post` | Before or after metadata deployment |
| `onlyIn` | string[] | all | Environments to run in (e.g. `[PROD]`) |
| `skipIn` | string[] | none | Environments to skip |
| `runOnce` | bool | true | Never re-run once successful (tracking). `false` = run on every `run` (rare, e.g. asserts) |
| `backup` | bool | config default | Snapshot records before update/delete |
| `maxRecords` | int | config default | Fail plan/run if selection exceeds this |
| `expectRecords` | int | — | Fail if selection count ≠ this |
| `batchSize` | int | auto | Records per API call. `1` = sequential single-record calls (for trigger/locking-sensitive objects) |
| `continueOnError` | bool | false | Continue with next step if this one fails |
| `maxFailures` | int | 0 | Allowed failed records before the step is marked failed |
| `preCheck` / `postCheck` | assert | — | Inline assert (see `assert` type) before/after the step |

### 9.2 Record selection (for `update`, `delete`, `assert`)

Exactly **one** of `query`, `ids`, `idsFile` must be provided.

**a) Query**
```yaml
object: Account
query: SELECT Id, Region__c FROM Account WHERE Region__c = null
```
- Must be a `SELECT` on `object`. Must include `Id`. Fields used in `modify` must be selected (runner auto-adds missing ones).

**b) Ids per environment**
```yaml
object: Case
ids:
  DEV:  [500000000000001AAA]
  UAT:  [500000000000002AAA]
  PROD: [500000000000003AAA]
# or the same Ids everywhere (e.g. full-copy sandbox refreshed from PROD):
ids:
  ALL: [500000000000003AAA]
onMissingEnv: fail          # fail (default) | skip — when target env has no Ids listed
where: Owner.Name = 'ForgottenQueue'   # optional guard condition, strongly recommended with Ids
```

**c) Ids from a per-environment file**
```yaml
idsFile: data/DSDSW-1542_ids_{{ env }}.csv   # single column "Id"
```

**Id validation rules (enforced in `validate`/`plan`):**
1. 15 or 18 characters, valid Salesforce Id format (18-char checksum verified).
2. Key prefix must match `object` (resolved via describe, e.g. `500` = Case).
3. Every Id must exist in the target org; missing Ids are reported and fail the step.
4. If `where` is present, the runner queries `SELECT Id ... WHERE Id IN (:ids) AND (<where>)`; records not matching are **skipped and reported** (not an error unless `expectRecords` is set).

### 9.3 Step types

#### `update`
Update selected records with fixed values (`set`) and/or delimited-list operations (`modify`).

```yaml
- id: backfill-region
  type: update
  object: Account
  query: SELECT Id FROM Account WHERE Region__c = null AND Type = 'Partner'
  set:
    Region__c: EMEA
    OwnerId: "{{ user('integration.user@company.com') }}"
  backup: true
  postCheck:
    query: SELECT COUNT() FROM Account WHERE Region__c = null AND Type = 'Partner'
    expect: 0
```

`modify` — for multi-select picklists and semicolon (or other) delimited text fields:
```yaml
  modify:
    DYN_Permission_Set_Names__c:
      delimiter: ";"            # default ";"
      add: [DYN_ICB_ROLE_Fraud_Ops, DYN_ICB_ROLE_KYC_QC]
      remove: [OLD_VALUE]
      replace: { from: "North America", to: "NA" }
```
Algorithm per record: split on delimiter → trim → apply `replace`, then `remove`, then `add` (append, preserving existing order) → de-duplicate → drop blanks → join. **If the result equals the current value, the record is skipped (not written).** Null field + `add` → just the added values.
Validations: for restricted picklists, added values must exist in the field describe (fail in `plan`); result length must not exceed field length (report offending records).

#### `upsert`
Insert or update records matched by a field (External Id **or any unique-in-practice field such as `Name`**).

```yaml
- id: upsert-generic-role-mappings
  type: upsert
  object: DYN_Permission_Set_Mapping__c
  matchOn: Name                     # if not an External Id field, runner queries existing records by this field, then updates or inserts
  file: data/DYN-612109_role_mappings.csv
  # OR inline:
  records:
    - Name: DYNGetELetterPlaceholders
      Query_String__c: "{{ file('queries/getEletterPlaceholders.graphql') }}"
  batchSize: 1
```
- If `matchOn` is a real External Id field → use Bulk/REST upsert natively.
- Otherwise → query `SELECT Id, <matchOn>, <fields> FROM object WHERE <matchOn> IN (...)`; **fail if any key matches more than one record**; update matched (skip unchanged), insert unmatched.
- CSV header = field API names. Template functions allowed in CSV cells.
- Lookup columns may use relationship syntax `Owner.Username`, `RecordType.DeveloperName` — resolved by the runner to Ids.

#### `insert`
Like `upsert` without matching. Requires `runOnce: true` (forced). Warn in plan that re-running after tracking loss would duplicate.

#### `delete`
```yaml
- id: delete-de-mappings
  type: delete
  object: DYN_Permission_Set_Mapping__c
  query: SELECT Id FROM DYN_Permission_Set_Mapping__c WHERE Name LIKE 'DE%' AND DYN_Country__c = 'DE'
  batchSize: 1
  backup: true          # forced true for delete
  hardDelete: false     # never true in v1
```

#### `groupMember`
Add/remove members of public groups or queues using readable references.
```yaml
- id: add-underwriter-div-lead-to-team-leader
  type: groupMember
  group: DYN_team_leader              # Group.DeveloperName (public group or queue)
  add:
    - role: Underwriter_Division_Lead        # UserRole.DeveloperName → related Group (Type='Role')
    - roleAndSubordinates: Head_Of_Fraud     # Group Type='RoleAndSubordinates'
    - user: someone@company.com              # Username (usernameSuffix applied)
    - group: Other_Public_Group
  remove:
    - user: leaver@company.com
```
Idempotent: skips members already present / already absent.

#### `permsetAssignment`
```yaml
- id: assign-sales-ops
  type: permsetAssignment
  permissionSet: Sales_Ops_Access         # or permissionSetGroup: <DeveloperName>
  users:
    query: SELECT Id FROM User WHERE Profile.Name = 'Sales Ops' AND IsActive = true
    # or usernames: [a@company.com, b@company.com]
  action: assign                          # assign | revoke
```

#### `assert`
Read-only check. Fails the step (and the run, unless `continueOnError`) if not met.
```yaml
- id: verify-mappings
  type: assert
  query: SELECT COUNT() FROM DYN_Permission_Set_Mapping__c WHERE Name LIKE 'DE%'
  expect: 0              # or expectMin / expectMax
  runOnce: false
```

#### `manual`
Pauses execution until a human confirms.
```yaml
- id: create-cti-flow-onmissed
  type: manual
  instructions: |
    1. App Launcher → "AC CTI Adapters" → open "ACLightningAdapter"
    2. CTI Flows tab → New → Event "onMissed", Source "Amazon Connect Chat Contact" → Save
  verify:                         # optional assert run after confirmation
    query: SELECT COUNT() FROM <CTI flow object> WHERE <criteria>
    expectMin: 1
```
Behaviour: see §11.4.

#### `apex` (Phase 2)
Runs an anonymous Apex file from `scripts/apex/` only (code-owner approval required on that folder).
```yaml
- id: schedule-nightly-sync
  type: apex
  file: scripts/apex/schedule_nightly_sync.apex
```

#### `batchApex` (Phase 2)
Starts a deployed Batch Apex class and optionally waits for completion.
```yaml
- id: backfill-complex
  type: batchApex
  class: PD_R202611_BackfillRegion
  batchSize: 200
  waitForCompletion: true
  timeoutMinutes: 60
```

#### Phase 2+ types (design only)
`schedule` / `abortJob` (scheduled Apex), `capture`-generated upserts, `http` (whitelisted hosts, secrets from Jenkins credentials), `tooling` (e.g. activate a Flow version), `notify` (Teams/Slack/email), `runTests`, `bypass` wrapper (toggle a bypass custom setting around a step).

### 9.4 Template functions

Usable in `set`, `records`, CSV cells, `query`, `where`, `idsFile`.

| Function | Resolves to |
|---|---|
| `{{ env }}` | Current environment name (e.g. `UAT`) |
| `{{ user('username') }}` | User Id; `usernameSuffix` of env appended automatically. Fails if not found/inactive |
| `{{ queue('DeveloperName') }}` | Queue (Group Type='Queue') Id |
| `{{ group('DeveloperName') }}` | Public group Id |
| `{{ role('DeveloperName') }}` | UserRole Id |
| `{{ recordType('Object', 'DeveloperName') }}` | RecordType Id |
| `{{ profile('Name') }}` | Profile Id |
| `{{ permissionSet('Name') }}` | PermissionSet Id |
| `{{ file('relative/path') }}` | File contents (relative to the release folder) |
| `{{ var('NAME') }}` | Per-env value from `pd.config.yaml` |
| `{{ secret('NAME') }}` | Value from environment variable (Jenkins credentials). **Never logged, never written to reports/backups.** |
| `{{ today }}` / `{{ now }}` | Date / datetime (ISO) |

All lookups are resolved **once in plan**, and unresolved references fail the plan.

## 10. Execution Tracking — `PD_Step_Execution__c`

Custom object deployed to every org (shipped as metadata in the repo under `force-app/pd-tracking/`).

| Field | Type | Notes |
|---|---|---|
| `Name` | Auto-number | |
| `Execution_Key__c` | Text(255), **External Id, Unique** | `<STORY>|<STEP_ID>` — release-independent so moving a story between releases does not re-run it |
| `Release__c` | Text(50) | Release in which it executed |
| `Story__c` | Text(50) | Jira key |
| `Step_Id__c` | Text(100) | |
| `Step_Type__c` | Text(40) | |
| `Status__c` | Picklist | `Success`, `Failed`, `Skipped`, `AwaitingManual`, `ManualConfirmed` |
| `Checksum__c` | Text(64) | SHA-256 of the normalized step definition + referenced data files |
| `Records_Selected__c` | Number | |
| `Records_Processed__c` | Number | |
| `Records_Failed__c` | Number | |
| `Started_At__c` / `Completed_At__c` | DateTime | |
| `Executed_By__c` | Text(255) | Jenkins user / confirmer for manual |
| `Build_URL__c` | URL | Jenkins `BUILD_URL` |
| `Backup_Reference__c` | Text(255) | Path in Jenkins archive |
| `Error_Message__c` | Long Text(32k) | |

Rules:
- A step is **pending** in an org if there is no record with `Status__c` in (`Success`, `ManualConfirmed`) for its `Execution_Key__c` (or `runOnce: false`).
- If a step already succeeded but its **checksum changed**, `plan` emits a **warning** ("modified after execution — create a new step id to apply changes"); it is **not** re-run.
- Failed steps are retried on the next `run`.
- Access to the object restricted to the deployment/integration user via a permission set.

## 11. CLI Commands

All commands accept `--json` (standard sf). Release can be given via `--release` or inferred from Git branch `release/<RELEASE>`.

### 11.1 `sf pd new`
Scaffold a story file (or add a step to an existing one) from a template.
```
sf pd new --release R2026.11 --story DYN-742926 --type update [--description "..."]
```

### 11.2 `sf pd validate`
Offline: JSON Schema validation, Id format checks, filename/story match, duplicate step ids, referenced files exist, no secrets in plain text (heuristic). No org needed. Used in PR builds.
```
sf pd validate [--release R2026.11 | --all]
```

### 11.3 `sf pd plan`
Connects to org (read-only). Resolves env, templates, selections; checks tracking; produces counts, sample before/after diffs (first 10 records per step), guard results, warnings.
```
sf pd plan --release R2026.11 --target-org uat [--phase pre|post] [--report pd-reports/plan.html]
```

### 11.4 `sf pd run`
Executes pending steps in order. Writes tracking, backups, run report.
```
sf pd run --release R2026.11 --target-org prod [--phase pre|post] [--story DYN-742926] [--step <id>]
          [--dry-run] [--approved] [--report pd-reports/run.html]
```
**Manual steps:** when the runner reaches a pending `manual` step it writes `pd-reports/awaiting-manual.json` (step id + instructions), sets tracking status `AwaitingManual`, and **exits with code 3**. Jenkins shows an `input` prompt with the instructions; on approval it calls `sf pd confirm`, then re-invokes `sf pd run` which continues from the next pending step.

### 11.5 `sf pd confirm`
```
sf pd confirm --release R2026.11 --step <story>/<stepId> --target-org prod --by "<name>"
```
Runs the step's `verify` assert if present, then marks `ManualConfirmed`.

### 11.6 `sf pd status`
Table of all steps in a release with status per target org (pending / success / failed / awaiting manual / skipped by env).
```
sf pd status --release R2026.11 --target-org uat
```

### 11.7 Exit codes
| Code | Meaning |
|---|---|
| 0 | Success / nothing pending |
| 1 | Step failure |
| 2 | Validation/plan error (nothing executed) |
| 3 | Paused awaiting manual confirmation |
| 4 | Approval required (PROD without `--approved`) |

## 12. Execution Semantics

1. **Environment detection:** query Org Id → match `pd.config.yaml`. Unknown → exit 2.
2. **Release ordering:** if `releaseOrdering: strict` and an older (non-archived) release has pending steps in this org → exit 2 (override `--allow-out-of-order`).
3. **Order:** `release.yaml` `preSteps` (phase pre) → stories in `order`, then remaining stories alphabetically, respecting `dependsOn` → steps in file order → `postChecks` → `finalSteps`.
4. **Plan before run:** `run` always performs a full plan first; any plan error aborts before any write.
5. **API choice:** ≤ `bulkThreshold` records → REST sObject Collections (200/call); above → Bulk API 2.0; `batchSize: 1` → sequential single-record REST calls.
6. **Unchanged records** (same value after `set`/`modify`) are skipped and counted as `skipped`.
7. **Backups:** before any update/delete, export Id + all affected fields (all fields for delete) to `pd-backups/<ENV>/<RELEASE>/<STORY>/<STEP>/<timestamp>.csv`.
8. **Failures:** per-record errors written to `pd-reports/errors/<STORY>_<STEP>.csv`. If failures > `maxFailures` → step `Failed`; run stops unless `continueOnError`.
9. **PROD protection:** env with `requireApproval: true` requires `--approved` (set only by Jenkins after the input step).
10. **Logging:** never log secret values or full record payloads; log counts and Ids.

## 13. Metadata vs PD — Rules (Phase 0 quick wins)

These must be deployed as metadata and **must not** be PD steps:

| Change | How to deploy |
|---|---|
| Remove permission/custom permission from permission set | Deploy PermissionSet with `<enabled>false</enabled>` for the entry (omitting it does not remove it) |
| Picklist values available for a record type | Include `objects/<Obj>/recordTypes/<RT>.recordType-meta.xml` with `<picklistValues>` |
| Flow / Process Builder activation | Enable *Deploy processes and flows as active* in PROD (Process Automation Settings); deploy flows with `status: Active` |
| Custom Metadata Type records | Deploy `customMetadata/*.md-meta.xml` |
| Queues (incl. members), Named Credentials, etc. | Deploy as metadata |

`sf pd validate` should warn when a step looks like one of these (e.g. `manual` instructions containing "Permission Set" + "remove", "Record Types" + "picklist").

## 14. Jenkins (CloudBees) Integration

```groovy
pipeline {
  agent any
  parameters {
    string(name: 'RELEASE', defaultValue: '', description: 'e.g. R2026.11 (blank = derive from branch)')
    choice(name: 'TARGET_ORG', choices: ['dev', 'qa', 'uat', 'prod'], description: 'sf org alias')
  }
  environment {
    RELEASE_ID = "${params.RELEASE ?: env.BRANCH_NAME.replace('release/', '')}"
  }
  stages {
    stage('Auth') {
      steps {
        withCredentials([file(credentialsId: "sf-jwt-key-${params.TARGET_ORG}", variable: 'JWT_KEY'),
                         string(credentialsId: "sf-client-id-${params.TARGET_ORG}", variable: 'CLIENT_ID'),
                         string(credentialsId: "sf-username-${params.TARGET_ORG}", variable: 'SF_USER')]) {
          sh 'sf org login jwt --client-id $CLIENT_ID --jwt-key-file $JWT_KEY --username $SF_USER --alias $TARGET_ORG'
        }
      }
    }
    stage('PD Validate') {
      steps { sh "sf pd validate --release ${RELEASE_ID}" }
    }
    stage('PD Pre-Deploy Steps') {
      steps { script { runPd('pre') } }
    }
    stage('Deploy Metadata') {
      steps { sh "sf project deploy start --target-org ${params.TARGET_ORG} --wait 120" }
    }
    stage('PD Plan') {
      steps {
        sh "sf pd plan --release ${RELEASE_ID} --target-org ${params.TARGET_ORG} --phase post --report pd-reports/plan.html"
        archiveArtifacts 'pd-reports/plan.html'
      }
    }
    stage('PD Approval') {
      when { expression { params.TARGET_ORG == 'prod' } }
      steps { input message: "Review pd-reports/plan.html. Execute PD steps for ${RELEASE_ID} in PROD?", submitter: 'release-managers' }
    }
    stage('PD Post-Deploy Steps') {
      steps { script { runPd('post') } }
    }
  }
  post {
    always { archiveArtifacts allowEmptyArchive: true, artifacts: 'pd-reports/**, pd-backups/**' }
  }
}

def runPd(String phase) {
  def approved = params.TARGET_ORG == 'prod' ? '--approved' : ''
  while (true) {
    def rc = sh(returnStatus: true,
      script: "sf pd run --release ${RELEASE_ID} --target-org ${params.TARGET_ORG} --phase ${phase} ${approved} --report pd-reports/run-${phase}.html")
    if (rc == 0) { return }
    if (rc == 3) {
      def pending = readJSON file: 'pd-reports/awaiting-manual.json'
      def who = input(message: "MANUAL STEP ${pending.step}:\n${pending.instructions}\n\nConfirm when done.",
                      submitter: 'release-managers,deployers', submitterParameter: 'approver')
      sh "sf pd confirm --release ${RELEASE_ID} --step ${pending.step} --target-org ${params.TARGET_ORG} --by '${who}'"
      continue
    }
    error("PD steps failed (exit ${rc}). See pd-reports/run-${phase}.html")
  }
}
```
(`readJSON` requires the Pipeline Utility Steps plugin.)

**PR build:** run `sf pd validate --all` and `sf pd plan` against a validation sandbox; attach plan report to the PR.

## 15. Developer Experience

- **JSON Schema** at `pd-steps/schema/pd-step.schema.json`; VS Code `settings.json`:
  ```json
  "yaml.schemas": { "./pd-steps/schema/pd-step.schema.json": "pd-steps/**/*.yaml" }
  ```
- **Cookbook** (`docs/pd-cookbook.md`): one copy-paste example per step type (use §16 examples).
- **Rules for developers:**
  1. Prefer `query`; use `ids` only for one-off record fixes, always with `where`.
  2. Every step must be safe to run twice.
  3. Keep `backup: true` for update/delete.
  4. No secrets in YAML — use `{{ secret() }}`.
  5. Never edit a step that has already run in any org — add a new step.
  6. Run `sf pd validate` and `sf pd plan --target-org <your sandbox>` before raising the PR.
- **PR template checkbox:** "This story requires PD steps → file added under `pd-steps/<release>/`".

## 16. Reference Examples (from real release PD documents, sanitized)

**Append values to a semicolon-separated field (DYN-742926)**
```yaml
story: DYN-742926
owner: dev.name
steps:
  - id: append-permsets-fraud-fincrime
    type: update
    object: DYN_Permission_Set_Mapping__c
    query: >
      SELECT Id, DYN_Permission_Set_Names__c FROM DYN_Permission_Set_Mapping__c
      WHERE Name = 'Fraud & Fincrime Channel - All Markets'
    modify:
      DYN_Permission_Set_Names__c:
        delimiter: ";"
        add: [DYN_ICB_ROLE_Fraud_Ops, DYN_ICB_ROLE_KYC_QC]
    expectRecords: 1
```

**Delete + upsert configuration records (DYN-612109)** — replaces two anonymous Apex scripts
```yaml
story: DYN-612109
owner: dev.name
steps:
  - id: delete-de-mappings
    type: delete
    object: DYN_Permission_Set_Mapping__c
    query: >
      SELECT Id FROM DYN_Permission_Set_Mapping__c
      WHERE Name LIKE 'DE%' AND DYN_Country__c = 'DE'
    batchSize: 1
  - id: upsert-generic-role-mappings
    type: upsert
    object: DYN_Permission_Set_Mapping__c
    matchOn: Name
    file: data/DYN-612109_role_mappings.csv
    batchSize: 1
```

**Update a config record with a long text value from a file (DYN-733454)**
```yaml
story: DYN-733454
owner: dev.name
steps:
  - id: update-eletter-placeholders-query
    type: upsert
    object: ICB_GraphQL_Query__c
    matchOn: Name
    records:
      - Name: DYNGetELetterPlaceholders
        Query_String__c: "{{ file('queries/getEletterPlaceholders.graphql') }}"
```

**One-off record owner change in PROD only, by Id with guard (DSDSW-1542)**
```yaml
story: DSDSW-1542
owner: dev.name
steps:
  - id: reassign-blocked-approval-case
    type: update
    object: Case
    onlyIn: [PROD]
    ids:
      PROD: [500XXXXXXXXXXXXXXX]
    where: Owner.Name = 'ForgottenQueue'
    set:
      OwnerId: "{{ user('target.user@company.com') }}"
    expectRecords: 1
```

**Add a role to a public group (DYN-629199)**
```yaml
story: DYN-629199
owner: dev.name
steps:
  - id: add-underwriter-div-lead-to-team-leader
    type: groupMember
    group: DYN_team_leader
    add:
      - role: Underwriter_Division_Lead
```

**Managed-package UI configuration — manual in v1 (DYN-620564)**
```yaml
story: DYN-620564
owner: dev.name
steps:
  - id: create-cti-flow-onmissed
    type: manual
    instructions: |
      1. App Launcher → "AC CTI Adapters" → open "ACLightningAdapter"
      2. CTI Flows tab → New → Event "onMissed", Source "Amazon Connect Chat Contact"
      3. Build flow as per Jira DYN-620564 → Save → Active
```

**Should be metadata, not PD (DYN-634249, DYN-740554)** — see §13; `validate` should flag these if written as manual steps.

## 17. Testing Strategy

- **Unit tests** (no org): schema validation, template resolution, `modify` algorithm (null, duplicates, order, unchanged-skip, length overflow), Id validation (format, checksum, prefix), ordering/dependsOn resolution, checksum calculation, env detection.
- **Integration tests** (mocked `Connection` via `@salesforce/core/testSetup`): plan/run per step type, tracking writes, backups, failure thresholds, manual pause/confirm flow, exit codes.
- **E2E** (scratch org or dev sandbox, optional in CI): deploy `PD_Step_Execution__c` + a test custom object, run a sample release twice → second run is a no-op.
- Acceptance fixtures: the examples in §16.

## 18. Delivery Phases

### Phase 0 — Process quick wins (no tooling)
- Move metadata-type changes out of PD docs (§13). Enable deploy-flows-as-active in PROD.

### Phase 1 — MVP
- Plugin scaffold, config loader, JSON Schema, `validate`, `plan`, `run`, `status`, `confirm`, `new`
- Step types: `update` (`set`, `modify`), `upsert` (`matchOn`, file/records), `insert`, `delete`, `groupMember`, `permsetAssignment`, `assert`, `manual`
- Selection: `query`, `ids` (per env / ALL), `idsFile`, `where`, `onMissingEnv`
- Template functions (§9.4), `onlyIn`/`skipIn`, guards, backups, tracking object, reports, exit codes
- Jenkins stages (§14)
- **Pilot:** run one release in parallel with the existing PD document

### Phase 2
- `apex`, `batchApex`, `schedule`/`abortJob`, `capture` (export sandbox records → CSV + step), `rollback` for update steps from backups, `notify`
- Investigate automating In-App Guidance prompt activation and Amazon Connect CTI records
- Evaluate migrating `ICB_GraphQL_Query__c` to Custom Metadata Type
- **PD Step Builder UI** — `sf pd ui` launches a local web app (localhost) using the developer's existing `sf` org auth:
  - Pick release/story and step type from forms; object/field pickers driven by org describe; record search to pick records (converted to readable references or per-env `ids`)
  - Live preview: record count + before/after sample (calls the same planner as `sf pd plan`)
  - Output: writes/updates the story YAML in the local repo (YAML in Git remains the single source of truth; the UI never executes against non-dev orgs)
  - Read-only release view: all stories/steps of a release and their status per org (from `PD_Step_Execution__c`)

### Phase 3
- `http`, `tooling`, `bypass`, `runTests`; dashboard of PD status per release/org

## 19. Acceptance Criteria (Phase 1)

1. Running `sf pd run` twice for the same release/org: second run executes nothing and exits 0.
2. A step with `onlyIn: [PROD]` is reported as "skipped (env)" in UAT and executes in PROD.
3. `ids` with an Id of the wrong object prefix fails in `validate`; an Id missing in the org fails in `plan`.
4. `modify.add` on a record already containing the value results in 0 records written.
5. `maxRecords` exceeded → exit 2, no writes.
6. PROD run without `--approved` → exit 4, no writes.
7. A `manual` step exits 3 with `awaiting-manual.json`; after `confirm`, re-run continues with the next step.
8. Every update/delete produces a backup CSV before writing.
9. All six §16 example files pass `validate` and execute correctly against a sandbox.
10. Secrets passed via `{{ secret() }}` never appear in logs, reports or backups.

## 20. Open Questions

1. Can In-App Guidance prompt activation be done via Metadata/Tooling API? (Otherwise remains `manual`.)
2. Which object stores Amazon Connect CTI flows, and can its records be safely exported/upserted across orgs?
3. Do triggers on `DYN_Permission_Set_Mapping__c` assign permission sets to users? (Impacts batch sizing and any future move to Custom Metadata.)
4. Release naming convention and branch strategy (`release/<RELEASE>`?).
5. Who are the Jenkins `input` submitters for PROD approval and manual steps?
6. Where should backups be retained long-term (Jenkins archive retention vs. S3/Artifactory)?

## 21. Suggested Build Order (for an AI coding assistant)

Implement and test in this order, one module per PR:
1. Scaffold plugin (`sf dev generate plugin`), add dependencies, lint/test setup.
2. `config` + `release`/`story` loaders and JSON Schema; `sf pd validate` with unit tests.
3. Template resolver (§9.4) with unit tests (mock lookups).
4. Record selection (`query`, `ids`, `idsFile`, `where`) + Id validation.
5. `modify` algorithm (pure function) with exhaustive unit tests.
6. Tracking service (`PD_Step_Execution__c` metadata + read/write).
7. Planner + `sf pd plan` + JSON/HTML report.
8. Executor for `update`, `delete`, `upsert`, `insert` (REST collections + Bulk 2.0), backups, error CSVs.
9. `groupMember`, `permsetAssignment`, `assert`, `manual` + `sf pd confirm`.
10. `sf pd run`, `sf pd status`, `sf pd new`, exit codes.
11. Jenkinsfile stages and README/cookbook.
