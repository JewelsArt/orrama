fn main() {
    // Debug builds find 2A's prepared Node binary by its target triple (lib.rs `launch`).
    println!("cargo:rustc-env=ORRAMA_TARGET_TRIPLE={}", std::env::var("TARGET").expect("cargo sets TARGET"));
    tauri_build::build()
}
