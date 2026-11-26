#!/usr/bin/env bash
set -euo pipefail

fixture="$(cd "$(dirname "$0")" && pwd)"
target="${1:?Choose an owned empty APK output directory}"
test -d "$target"
test -z "$(ls -A "$target")"
sdk="${ANDROID_SDK_ROOT:-${ANDROID_HOME:?Use the installed Android SDK}}"
platform="$sdk/platforms/android-35/android.jar"
tools="$sdk/build-tools/35.0.0"

mvn -q -B -f "$fixture/pom.xml" org.apache.maven.plugins:maven-dependency-plugin:3.9.0:build-classpath \
  "-Dmdep.outputFile=$target/kotlin-classpath.txt"
classpath="$(cat "$target/kotlin-classpath.txt")"
stdlib="$(tr ':' '\n' < "$target/kotlin-classpath.txt" | sed -n '/\/kotlin-stdlib\/2\.4\.21\/kotlin-stdlib-2\.4\.21\.jar$/p')"
test -f "$stdlib"
compiler="$(tr ':' '\n' < "$target/kotlin-classpath.txt" | sed -n '/\/kotlin-compiler-embeddable\/2\.4\.21\/kotlin-compiler-embeddable-2\.4\.21\.jar$/p')"
test -f "$compiler"
echo "ef19419c765e7ac8404465fa026ca8fc4dbb8a822de0fc79aa53c8dce29f1d02  $compiler" | sha256sum --check --status || {
  echo 'Kotlin compiler distribution did not match the published digest.' >&2
  exit 1
}

cp "$fixture/MainActivity.kt" "$target/"
java -cp "$classpath" org.jetbrains.kotlin.cli.jvm.K2JVMCompiler \
  -no-stdlib -no-reflect -jvm-target 1.8 -classpath "$platform:$stdlib" \
  -d "$target/app-classes.jar" "$target/MainActivity.kt"
mkdir "$target/dex"
"$tools/d8" --debug --min-api 28 --lib "$platform" --output "$target/dex" "$target/app-classes.jar" "$stdlib"
"$tools/aapt2" link -I "$platform" --manifest "$fixture/AndroidManifest.xml" -o "$target/unsigned.apk"
(cd "$target/dex" && zip -q -0 "$target/unsigned.apk" classes*.dex)
"$tools/zipalign" -f -p 4 "$target/unsigned.apk" "$target/aligned.apk"
pass="$(openssl rand -hex 24)"
keytool -genkeypair -keystore "$target/signing.p12" -storetype PKCS12 -storepass "$pass" -keypass "$pass" \
  -alias rocketbrain-fixture -keyalg RSA -keysize 2048 -validity 1 -dname 'CN=Rocketbrain disposable emulator fixture'
"$tools/apksigner" sign --ks "$target/signing.p12" --ks-pass "pass:$pass" --out "$target/reviewed.apk" "$target/aligned.apk"
rm "$target/signing.p12"
"$tools/apksigner" verify "$target/reviewed.apk"
