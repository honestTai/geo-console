fn main() {
    let target = std::env::var("TARGET").expect("cargo target");
    let out = std::path::PathBuf::from(std::env::var("OUT_DIR").expect("cargo output"));
    std::fs::write(out.join("runtime-target.txt"), target).expect("write runtime target");
    tauri_build::build()
}
