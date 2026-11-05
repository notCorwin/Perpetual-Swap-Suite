use std::{env, fs, path::PathBuf};

fn main() {
    let manifest_dir =
        PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("manifest directory"));
    let out_dir = PathBuf::from(env::var_os("OUT_DIR").expect("build output directory"));

    // tauri-build writes gen/schemas relative to its working directory. Keep
    // generated files in Cargo's ignored target directory, not the source tree.
    fs::copy(manifest_dir.join("Cargo.toml"), out_dir.join("Cargo.toml"))
        .expect("copy manifest into build output");
    fs::create_dir_all(out_dir.join("capabilities")).expect("create empty capabilities directory");
    env::set_current_dir(&out_dir).expect("enter build output directory");
    tauri_build::try_build(
        tauri_build::Attributes::new().config_path(manifest_dir.join("tauri.conf.json")),
    )
    .expect("build Tauri configuration");
}
