import { it, expect } from "vitest";
import { setup } from "../helpers.js";
import { Registry } from "../../packages/registry/src/index.js";
import { digest } from "../../packages/shared/src/hash.js";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
it("migrates a v1 registry and conservatively recovers a run after its owner exits", async () => {
  const s = await setup(true);
  try {
    const code = `const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(process.argv[1]);db.prepare("INSERT INTO runs(id,hash,idempotency_key,status,started_at,owner_pid) VALUES(?,?,?,'RUNNING',CURRENT_TIMESTAMP,?)").run('crashed-run',process.argv[2],'crashed-key',process.pid);process.exit(77);`;
    const child = spawnSync(process.execPath, [
      "--input-type=module",
      "-e",
      code,
      join(s.directory, "registry.sqlite"),
      s.stored.hash,
    ]);
    expect(child.status).toBe(77);
    // Exercise the actual v1 → v2 schema transition without losing immutable content.
    s.registry.db.exec(
      "ALTER TABLE runs DROP COLUMN owner_pid; DELETE FROM registry_migrations WHERE version=2;",
    );
    const recovered = new Registry(s.directory);
    try {
      expect(
        recovered.db
          .prepare("SELECT MAX(version) AS version FROM registry_migrations")
          .get()?.version,
      ).toBe(2);
      expect(recovered.inspectRun("crashed-run").status).toBe(
        "OUTCOME_UNKNOWN",
      );
      expect(() =>
        recovered.startRun("retry", s.stored.hash, "crashed-key"),
      ).toThrow();
      expect(recovered.get(s.stored.workflow.slug).hash).toBe(s.stored.hash);
    } finally {
      recovered.close();
    }
  } finally {
    await s.close();
  }
});
it("immutable versions, slug collisions, tampering, publication and policy invalidation", async () => {
  const s = await setup();
  try {
    const { registry, stored } = s,
      w = stored.workflow;
    expect(() => registry.publish(w.slug, w.version)).toThrow(
      "WORKFLOW_NOT_VERIFIED",
    );
    expect(() => registry.import({ ...w, title: "Changed" })).toThrow(
      "Immutable",
    );
    expect(() => registry.import({ ...w, id: "wf_different" })).toThrow(
      "collision",
    );
    registry.attest(stored, { cases: [] }, "test-browser", []);
    registry.publish(w.slug, w.version);
    expect(registry.published()).toHaveLength(1);
    registry.setPolicy(registry.policy());
    expect(registry.published()).toHaveLength(0);
    registry.db
      .prepare("UPDATE versions SET content=? WHERE hash=?")
      .run(JSON.stringify({ ...w, title: "tampered" }), stored.hash);
    expect(() => registry.get(w.slug)).toThrow("WORKFLOW_HASH_MISMATCH");
  } finally {
    await s.close();
  }
});
it("SQLite rollback and restart preserve version integrity and reject duplicate idempotency keys", async () => {
  const s = await setup();
  try {
    expect(() =>
      s.registry.transaction(() => {
        s.registry.db.exec("DELETE FROM versions");
        throw new Error("injected crash");
      }),
    ).toThrow();
    const second = new Registry(s.directory);
    try {
      expect(second.get(s.stored.workflow.slug).hash).toBe(
        digest(s.stored.workflow),
      );
      expect(
        second.db.prepare("PRAGMA integrity_check").get()?.integrity_check,
      ).toBe("ok");
    } finally {
      second.close();
    }
    s.registry.startRun("r1", s.stored.hash, "key-1");
    expect(() => s.registry.startRun("r2", s.stored.hash, "key-1")).toThrow();
  } finally {
    await s.close();
  }
});
