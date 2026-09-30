//! CLI behaviour for `rustguac map-group`.
//!
//! These live here rather than in a `#[cfg(test)]` module inside `src/`
//! because they invoke the built binary. Cargo only exports
//! `CARGO_BIN_EXE_rustguac`, which `assert_cmd::cargo_bin` needs, to
//! integration tests. As unit tests they appeared to pass locally only
//! because a stale `target/debug/rustguac` happened to be present for
//! assert_cmd's fallback to find; on a clean checkout they failed.
//!
//! Database assertions go through rusqlite directly rather than the crate's
//! own helpers, since rustguac is a binary crate with no lib target for an
//! integration test to import. That is arguably the better boundary anyway:
//! it checks the state the CLI actually leaves behind.

use assert_cmd::Command;
use rusqlite::Connection;

/// Scratch directory for one test, removed on drop so a panicking test leaves
/// nothing behind. Named per test because cargo runs tests as threads within
/// one process, so a pid-only name would collide.
struct ScratchDir(std::path::PathBuf);

impl ScratchDir {
    fn new(name: &str) -> Self {
        let path =
            std::env::temp_dir().join(format!("rustguac-cli-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).expect("create scratch dir");
        std::fs::write(path.join("config.toml"), "db_path = \"./rustguac.db\"\n")
            .expect("write config");
        ScratchDir(path)
    }

    fn path(&self) -> &std::path::Path {
        &self.0
    }

    fn conn(&self) -> Connection {
        Connection::open(self.0.join("rustguac.db")).expect("open database")
    }

    /// Every group mapping as (group, role), ordered by id.
    fn mappings(&self) -> Vec<(String, String)> {
        let conn = self.conn();
        let mut stmt = conn
            .prepare("SELECT oidc_group, role FROM group_role_mappings ORDER BY id")
            .expect("prepare");
        let rows = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .expect("query");
        rows.map(|r| r.expect("row")).collect()
    }

    /// Runs the CLI against this scratch dir, returning the assertion so
    /// callers can require success or failure.
    fn run(&self, args: &[&str]) -> assert_cmd::assert::Assert {
        let mut cmd = Command::cargo_bin("rustguac").unwrap();
        cmd.current_dir(self.path())
            .args(["--config", "config.toml"])
            .args(args)
            .assert()
    }
}

impl Drop for ScratchDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn cli_map_group() {
    let dir = ScratchDir::new("map-group");
    dir.run(&["map-group", "--group", "superhumans", "--role", "admin"])
        .success();

    assert_eq!(
        dir.mappings(),
        vec![("superhumans".to_string(), "admin".to_string())]
    );
}

#[test]
fn cli_map_group_rejects_unknown_role() {
    let dir = ScratchDir::new("map-group-bad-role");
    dir.run(&["map-group", "--group", "superhumans", "--role", "root"])
        .failure();

    assert!(
        dir.mappings().is_empty(),
        "an invalid role must not create a mapping"
    );
}

/// A duplicate must fail with guidance rather than a raw UNIQUE constraint
/// error, and must leave the existing role untouched.
#[test]
fn cli_map_group_duplicate_needs_force() {
    let dir = ScratchDir::new("map-group-dup");
    dir.run(&["map-group", "--group", "staff", "--role", "viewer"])
        .success();

    let assert = dir
        .run(&["map-group", "--group", "staff", "--role", "admin"])
        .failure();
    let stderr = String::from_utf8_lossy(&assert.get_output().stderr).to_string();
    assert!(
        stderr.contains("--force"),
        "duplicate should point at --force, got: {stderr}"
    );
    assert!(
        !stderr.contains("UNIQUE"),
        "duplicate should not surface a raw SQL error, got: {stderr}"
    );

    assert_eq!(
        dir.mappings(),
        vec![("staff".to_string(), "viewer".to_string())],
        "role must be unchanged"
    );
}

#[test]
fn cli_map_group_force_remaps() {
    let dir = ScratchDir::new("map-group-force");
    dir.run(&["map-group", "--group", "staff", "--role", "viewer"])
        .success();
    dir.run(&[
        "map-group",
        "--group",
        "staff",
        "--role",
        "admin",
        "--force",
    ])
    .success();

    assert_eq!(
        dir.mappings(),
        vec![("staff".to_string(), "admin".to_string())],
        "force must re-map, not add a second row"
    );
}

/// Mapping a group to a role is a privilege grant, so it must leave an audit
/// trail even when done from a shell instead of the API.
#[test]
fn cli_map_group_is_audited() {
    let dir = ScratchDir::new("map-group-audit");
    dir.run(&["map-group", "--group", "staff", "--role", "admin"])
        .success();

    let conn = dir.conn();
    let (action, target, details): (String, String, String) = conn
        .query_row(
            "SELECT action, target, details FROM cli_audit_log ORDER BY id DESC LIMIT 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("an audit row should exist");

    assert_eq!(action, "map_group");
    assert_eq!(target, "staff");
    assert_eq!(details, "role=admin");
}
