{ pkgs, baseShell }:
let
  # Keep Android's license/unfree policy scoped to this explicitly selected shell.
  androidPkgs = import pkgs.path {
    system = pkgs.stdenv.hostPlatform.system;
    config = {
      allowUnfree = true;
      android_sdk.accept_license = true;
    };
  };
  android = androidPkgs.androidenv.composeAndroidPackages {
    cmdLineToolsVersion = "19.0";
    platformToolsVersion = "36.0.0";
    buildToolsVersions = [ "36.0.0" ];
    platformVersions = [ "35" "36" ];
    includeNDK = true;
    ndkVersions = [ "27.1.12297006" ];
    cmakeVersions = [ "3.30.5" ];
    includeEmulator = true;
    emulatorVersion = "36.3.10";
    includeSystemImages = true;
    systemImageTypes = [ "google_apis" ];
    abiVersions = [ "x86_64" ];
    includeSources = false;
  };
  sdk = "${android.androidsdk}/libexec/android-sdk";
in
pkgs.mkShell {
  inputsFrom = [ baseShell ];
  packages = [ android.androidsdk pkgs.jdk21 pkgs.bubblewrap ];
  JAVA_HOME = "${pkgs.jdk21}";
  ANDROID_HOME = sdk;
  ANDROID_SDK_ROOT = sdk;
  ANDROID_NDK_HOME = "${sdk}/ndk/27.1.12297006";
  PASEO_ANDROID_SDK = sdk;
  GRADLE_OPTS = "'-Dorg.gradle.jvmargs=-Xmx4096m -XX:MaxMetaspaceSize=1024m' -Dorg.gradle.daemon=false -Dorg.gradle.workers.max=1 -Dorg.gradle.parallel=false";
  shellHook = ''
    export PATH="${sdk}/cmdline-tools/latest/bin:${sdk}/platform-tools:${sdk}/emulator:$PATH"
    export GRADLE_OPTS="$GRADLE_OPTS -Dorg.gradle.project.android.aapt2FromMavenOverride=${sdk}/build-tools/36.0.0/aapt2"
    echo "Android SDK ready. Use npm run android:isolated -- <setup|doctor|run|emulator|smoke>."
  '';
}
