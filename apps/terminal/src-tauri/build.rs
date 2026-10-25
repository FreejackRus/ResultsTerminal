fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "is_enrolled",
            "enroll",
            "api_request",
            "get_pdf",
            "apply_config",
            "print_document",
            "get_health",
        ]),
    ))
    .expect("Tauri build failed");
}
