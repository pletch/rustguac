//! `rustguac add-admin --if-none`, as the Docker entrypoint uses it (#240).
//!
//! The entrypoint used to decide "first run" by looking for a database file
//! at a fixed path, so a config with db_path elsewhere tried to create the
//! admin on every start and failed on the one already there. The check now
//! belongs to rustguac, which reads db_path from the config.

use assert_cmd::Command;
use rusqlite::Connection;

struct ScratchDir(std::path::PathBuf);

impl ScratchDir {
    fn new(name: &str) -> Self {
        let path =
            std::env::temp_dir().join(format!("rustguac-cli-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(path.join("elsewhere")).expect("create scratch dir");
        // Deliberately not ./data/rustguac.db: the path the old entrypoint
        // hardcoded.
        std::fs::write(
            path.join("config.toml"),
            "db_path = \"./elsewhere/custom.db\"\n",
        )
        .expect("write config");
        ScratchDir(path)
    }

    fn run(&self, args: &[&str]) -> assert_cmd::assert::Assert {
        Command::cargo_bin("rustguac")
            .unwrap()
            .current_dir(&self.0)
            .args(["--config", "config.toml"])
            .args(args)
            .assert()
    }

    fn admin_count(&self) -> i64 {
        Connection::open(self.0.join("elsewhere/custom.db"))
            .expect("open database")
            .query_row("SELECT COUNT(*) FROM admins", [], |r| r.get(0))
            .expect("count admins")
    }
}

impl Drop for ScratchDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn if_none_creates_once_then_skips() {
    let dir = ScratchDir::new("add-admin-if-none");

    let first = dir
        .run(&["add-admin", "--name", "docker-admin", "--if-none"])
        .success();
    let out = String::from_utf8_lossy(&first.get_output().stdout).to_string();
    assert!(
        out.contains("API Key:"),
        "first run should print a key: {out}"
    );
    assert_eq!(dir.admin_count(), 1);

    // Every later container start: must succeed, print no key, add nothing.
    for _ in 0..2 {
        let again = dir
            .run(&["add-admin", "--name", "docker-admin", "--if-none"])
            .success();
        let out = String::from_utf8_lossy(&again.get_output().stdout).to_string();
        assert!(
            !out.contains("API Key:"),
            "must not mint another key: {out}"
        );
        assert!(out.contains("already exist"), "should say why: {out}");
    }
    assert_eq!(dir.admin_count(), 1);
}

/// An admin under another name still counts: the operator may have removed
/// docker-admin after creating their own, and it must not come back.
#[test]
fn if_none_respects_any_existing_admin() {
    let dir = ScratchDir::new("add-admin-if-none-other");
    dir.run(&["add-admin", "--name", "ops"]).success();
    dir.run(&["add-admin", "--name", "docker-admin", "--if-none"])
        .success();
    assert_eq!(dir.admin_count(), 1);
}

/// Without the flag, a duplicate is still an error, as before.
#[test]
fn without_if_none_duplicate_still_fails() {
    let dir = ScratchDir::new("add-admin-dup");
    dir.run(&["add-admin", "--name", "docker-admin"]).success();
    dir.run(&["add-admin", "--name", "docker-admin"]).failure();
}
