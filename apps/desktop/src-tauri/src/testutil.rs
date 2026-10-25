//! Test helpers.
use std::fs;
use std::path::PathBuf;

/// A new empty folder under the system's temp folder; the test removes it.
pub fn tempdir() -> PathBuf {
    let mut b = [0u8; 8];
    getrandom::fill(&mut b).unwrap();
    let name: String = b.iter().map(|x| format!("{x:02x}")).collect();
    let dir = std::env::temp_dir().join(format!("orrama-shell-test-{name}"));
    fs::create_dir_all(&dir).unwrap();
    dir
}
