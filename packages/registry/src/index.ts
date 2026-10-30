import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  parseWorkflow,
  canonicalize,
  type Workflow,
} from "../../workflow-schema/src/index.js";
import { digest } from "../../shared/src/hash.js";
import { fail, POLICY_VERSION, VERSION } from "../../shared/src/index.js";
import {
  installationSchema,
  type InstallationPolicy,
} from "../../policy/src/index.js";

export const BROWSER_BUILD = "playwright-1.64.1";
export const RUNNER_BUILD = `${VERSION}/node-${process.versions.node}`;
export interface StoredWorkflow {
  workflow: Workflow;
  hash: string;
  trusted: boolean;
  verified: boolean;
  published: boolean;
}
export class Registry {
  db: DatabaseSync;
  directory: string;
  constructor(directory: string) {
    this.directory = resolve(directory);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    chmodSync(this.directory, 0o700);
    this.db = new DatabaseSync(join(this.directory, "registry.sqlite"));
    chmodSync(join(this.directory, "registry.sqlite"), 0o600);
    this.db
      .exec(`PRAGMA secure_delete=ON; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS registry_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT OR IGNORE INTO registry_migrations VALUES(1, CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS versions(id TEXT NOT NULL, slug TEXT NOT NULL, version TEXT NOT NULL, hash TEXT NOT NULL UNIQUE, content TEXT NOT NULL, trusted INTEGER NOT NULL DEFAULT 0, verified INTEGER NOT NULL DEFAULT 0, published INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(slug,version));
      CREATE UNIQUE INDEX IF NOT EXISTS one_published_revision ON versions(slug) WHERE published=1;
      CREATE TABLE IF NOT EXISTS verifications(hash TEXT PRIMARY KEY REFERENCES versions(hash) ON DELETE CASCADE, suite_hash TEXT NOT NULL, browser TEXT NOT NULL, runner TEXT NOT NULL, policy TEXT NOT NULL, policy_hash TEXT NOT NULL, timestamp TEXT NOT NULL, report TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS approvals(nonce TEXT PRIMARY KEY, hash TEXT NOT NULL REFERENCES versions(hash) ON DELETE CASCADE, input_digest TEXT NOT NULL, actor TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER, policy_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, hash TEXT NOT NULL REFERENCES versions(hash) ON DELETE CASCADE, idempotency_key TEXT UNIQUE, status TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, error_code TEXT, metrics TEXT);
      CREATE TABLE IF NOT EXISTS audit_events(id INTEGER PRIMARY KEY, run_id TEXT, event TEXT NOT NULL, payload TEXT NOT NULL, timestamp TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE INDEX IF NOT EXISTS run_lookup ON runs(hash,status,started_at);
    `);
    this.transaction(() => {
      const version = this.db
        .prepare("SELECT MAX(version) AS version FROM registry_migrations")
        .get()?.version;
      if (version === 1) {
        this.db.exec(
          "ALTER TABLE runs ADD COLUMN owner_pid INTEGER NOT NULL DEFAULT 0; INSERT INTO registry_migrations VALUES(2,CURRENT_TIMESTAMP);",
        );
      } else if (version !== 2)
        fail(
          "WORKFLOW_SCHEMA_UNSUPPORTED",
          "Unknown registry migration version.",
        );
    });
    // Never recover another live CLI/MCP process's run. A dead writer may have
    // committed remotely; retain idempotency keys and prohibit automatic retry.
    for (const run of this.db
      .prepare("SELECT id,owner_pid FROM runs WHERE status='RUNNING'")
      .all()) {
      let alive = Number(run.owner_pid) > 0;
      if (alive) {
        try {
          process.kill(Number(run.owner_pid), 0);
        } catch (e) {
          alive = (e as NodeJS.ErrnoException).code !== "ESRCH";
        }
      }
      if (!alive)
        this.finishRun(
          run.id as string,
          "OUTCOME_UNKNOWN",
          {},
          "OUTCOME_UNKNOWN",
        );
    }
  }
  close() {
    this.db.close();
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  audit(
    event: string,
    payload: Record<string, string | number | boolean | null> = {},
    runId: string | null = null,
  ) {
    // Call sites use only allowlisted operational metadata; no arguments, DOM, URLs, or exception text.
    this.db
      .prepare("INSERT INTO audit_events(run_id,event,payload) VALUES(?,?,?)")
      .run(runId, event, canonicalize(payload));
  }
  policy(): InstallationPolicy {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key='policy'")
      .get();
    return row
      ? installationSchema.parse(JSON.parse(row.value as string))
      : { version: 1, grants: [] };
  }
  setPolicy(policy: InstallationPolicy) {
    const p = installationSchema.parse(policy);
    this.transaction(() => {
      this.db
        .prepare("INSERT OR REPLACE INTO settings VALUES('policy',?)")
        .run(canonicalize(p));
      this.db.exec(
        "UPDATE versions SET verified=0,published=0; DELETE FROM verifications; DELETE FROM approvals;",
      );
      this.audit("policy.updated", { grants: p.grants.length });
    });
  }
  import(input: unknown): StoredWorkflow {
    const w = parseWorkflow(input),
      hash = digest(w);
    return this.transaction(() => {
      const conflicts = this.db
        .prepare("SELECT id,slug,hash FROM versions WHERE slug=? OR id=?")
        .all(w.slug, w.id);
      if (conflicts.some((c) => c.id !== w.id || c.slug !== w.slug))
        fail("WORKFLOW_INVALID", "Workflow ID/slug collision.");
      const existing = this.db
        .prepare("SELECT hash FROM versions WHERE slug=? AND version=?")
        .get(w.slug, w.version);
      if (existing && existing.hash !== hash)
        fail(
          "WORKFLOW_HASH_MISMATCH",
          "Immutable version already exists; increment workflow version.",
        );
      this.db
        .prepare(
          "INSERT OR IGNORE INTO versions(id,slug,version,hash,content) VALUES(?,?,?,?,?)",
        )
        .run(w.id, w.slug, w.version, hash, canonicalize(w));
      this.audit("workflow.imported", { hash });
      return this.get(w.slug, w.version);
    });
  }
  get(slug: string, version?: string): StoredWorkflow {
    const rows = this.db
      .prepare("SELECT * FROM versions WHERE slug=?")
      .all(slug);
    const row = version
      ? rows.find((r) => r.version === version)
      : rows.sort((a, b) => {
          const av = (a.version as string).split(".").map(Number),
            bv = (b.version as string).split(".").map(Number);
          return bv[0]! - av[0]! || bv[1]! - av[1]! || bv[2]! - av[2]!;
        })[0];
    if (!row) fail("WORKFLOW_INVALID", "Unknown workflow revision.");
    const w = parseWorkflow(JSON.parse(row.content as string));
    if (
      digest(w) !== row.hash ||
      w.slug !== row.slug ||
      w.version !== row.version ||
      w.id !== row.id
    )
      fail("WORKFLOW_HASH_MISMATCH");
    return {
      workflow: w,
      hash: row.hash as string,
      trusted: row.trusted === 1,
      verified: row.verified === 1,
      published: row.published === 1,
    };
  }
  list() {
    return this.db
      .prepare(
        "SELECT id,slug,version,hash,trusted,verified,published FROM versions ORDER BY slug,version",
      )
      .all();
  }
  trust(slug: string, hash: string, version?: string) {
    const stored = this.get(slug, version);
    if (hash !== stored.hash) fail("WORKFLOW_HASH_MISMATCH");
    if (["destructive", "unknown"].includes(stored.workflow.policy.risk))
      fail(
        "PERMISSION_DENIED",
        "Destructive/unknown workflows cannot be trusted.",
      );
    this.db.prepare("UPDATE versions SET trusted=1 WHERE hash=?").run(hash);
    this.audit("workflow.reviewed", {
      hash,
      risk: stored.workflow.policy.risk,
    });
  }
  attest(
    stored: StoredWorkflow,
    suite: unknown,
    browser: string,
    report: unknown,
  ) {
    this.transaction(() => {
      if (
        this.get(stored.workflow.slug, stored.workflow.version).hash !==
        stored.hash
      )
        fail("WORKFLOW_HASH_MISMATCH");
      this.db
        .prepare("INSERT OR REPLACE INTO verifications VALUES(?,?,?,?,?,?,?,?)")
        .run(
          stored.hash,
          digest(suite),
          `${BROWSER_BUILD}/${browser}`,
          RUNNER_BUILD,
          POLICY_VERSION,
          digest(this.policy()),
          new Date().toISOString(),
          canonicalize(report),
        );
      this.db
        .prepare("UPDATE versions SET verified=1 WHERE hash=?")
        .run(stored.hash);
      this.audit("workflow.verified", { hash: stored.hash });
    });
  }
  invalidate(hash: string) {
    this.db
      .prepare("UPDATE versions SET verified=0,published=0 WHERE hash=?")
      .run(hash);
    this.db.prepare("DELETE FROM verifications WHERE hash=?").run(hash);
  }
  assertVerified(stored: StoredWorkflow) {
    const v = this.db
      .prepare("SELECT * FROM verifications WHERE hash=?")
      .get(stored.hash);
    if (
      !stored.trusted ||
      !stored.verified ||
      !v ||
      v.policy !== POLICY_VERSION ||
      v.runner !== RUNNER_BUILD ||
      !(v.browser as string).startsWith(`${BROWSER_BUILD}/`) ||
      v.policy_hash !== digest(this.policy())
    )
      fail("WORKFLOW_NOT_VERIFIED");
  }
  publish(slug: string, version: string) {
    this.transaction(() => {
      const stored = this.get(slug, version);
      this.assertVerified(stored);
      this.db.prepare("UPDATE versions SET published=0 WHERE slug=?").run(slug);
      this.db
        .prepare("UPDATE versions SET published=1 WHERE hash=?")
        .run(stored.hash);
      this.audit("workflow.published", { hash: stored.hash });
    });
  }
  published() {
    return this.db
      .prepare(
        "SELECT slug,version FROM versions WHERE published=1 ORDER BY slug",
      )
      .all()
      .map((r) => {
        const s = this.get(r.slug as string, r.version as string);
        this.assertVerified(s);
        return s;
      });
  }
  disable(slug: string) {
    this.db.prepare("UPDATE versions SET published=0 WHERE slug=?").run(slug);
    this.audit("workflow.disabled");
  }
  approve(
    stored: StoredWorkflow,
    inputs: unknown,
    actor: string,
    ttlMs = 60000,
  ) {
    if (
      !stored.trusted ||
      !["read", "write"].includes(stored.workflow.policy.risk) ||
      (!stored.workflow.policy.requiresApproval &&
        stored.workflow.policy.risk === "read")
    )
      fail("PERMISSION_DENIED");
    const nonce = randomUUID();
    this.db
      .prepare("INSERT INTO approvals VALUES(?,?,?,?,?,NULL,?)")
      .run(
        nonce,
        stored.hash,
        digest(inputs),
        actor,
        Date.now() + Math.min(ttlMs, 120000),
        digest(this.policy()),
      );
    this.audit("approval.granted", { hash: stored.hash });
    return nonce;
  }
  consumeApproval(
    stored: StoredWorkflow,
    inputs: unknown,
    actor: string,
    nonce?: string,
  ) {
    if (!nonce)
      fail(
        "APPROVAL_REQUIRED",
        "Approve this exact revision and input through the local CLI.",
      );
    this.transaction(() => {
      const a = this.db
        .prepare("SELECT * FROM approvals WHERE nonce=?")
        .get(nonce);
      if (
        !a ||
        a.used_at !== null ||
        a.hash !== stored.hash ||
        a.input_digest !== digest(inputs) ||
        a.actor !== actor ||
        a.policy_hash !== digest(this.policy())
      )
        fail("APPROVAL_REQUIRED");
      if (Number(a.expires_at) < Date.now()) fail("APPROVAL_EXPIRED");
      this.db
        .prepare(
          "UPDATE approvals SET used_at=? WHERE nonce=? AND used_at IS NULL",
        )
        .run(Date.now(), nonce);
      this.audit("approval.consumed", { hash: stored.hash });
    });
  }
  pendingApproval(stored: StoredWorkflow, inputs: unknown, actor: string) {
    const row = this.db
      .prepare(
        "SELECT nonce FROM approvals WHERE hash=? AND input_digest=? AND actor=? AND used_at IS NULL AND expires_at>? AND policy_hash=? ORDER BY expires_at LIMIT 1",
      )
      .get(
        stored.hash,
        digest(inputs),
        actor,
        Date.now(),
        digest(this.policy()),
      );
    return row?.nonce as string | undefined;
  }
  startRun(id: string, hash: string, idempotencyKey?: string) {
    if (
      idempotencyKey &&
      this.db
        .prepare("SELECT id FROM runs WHERE idempotency_key=?")
        .get(idempotencyKey)
    )
      fail(
        "RUN_ALREADY_IN_PROGRESS",
        "This idempotency key has already been used; inspect the original run.",
      );
    this.db
      .prepare(
        "INSERT INTO runs(id,hash,idempotency_key,status,started_at,owner_pid) VALUES(?,?,?,?,?,?)",
      )
      .run(
        id,
        hash,
        idempotencyKey ?? null,
        "RUNNING",
        new Date().toISOString(),
        process.pid,
      );
    this.audit("run.started", { hash }, id);
  }
  finishRun(id: string, status: string, metrics: unknown, code?: string) {
    this.db
      .prepare(
        "UPDATE runs SET status=?,finished_at=?,error_code=?,metrics=? WHERE id=?",
      )
      .run(
        status,
        new Date().toISOString(),
        code ?? null,
        canonicalize(metrics),
        id,
      );
    this.audit("run.finished", { status, code: code ?? null }, id);
  }
  inspectRun(id: string) {
    return (
      this.db.prepare("SELECT * FROM runs WHERE id=?").get(id) ??
      fail("WORKFLOW_INVALID", "Unknown run.")
    );
  }
  eraseWorkflow(slug: string) {
    this.transaction(() => {
      const rows = this.db
        .prepare("SELECT hash FROM versions WHERE slug=?")
        .all(slug);
      for (const row of rows)
        this.db
          .prepare("DELETE FROM runs WHERE hash=?")
          .run(row.hash as string);
      this.db.prepare("DELETE FROM versions WHERE slug=?").run(slug);
      this.audit("workflow.erased");
    });
  }
  eraseAudit() {
    this.db.exec(
      "DELETE FROM audit_events; PRAGMA wal_checkpoint(TRUNCATE); VACUUM;",
    );
  }
}
