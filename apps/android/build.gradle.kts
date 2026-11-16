// BLOCKADE ARENA — native Android client (Kotlin + Jetpack Compose).
// Top-level build file. Plugin versions are the single source of truth here;
// app/build.gradle.kts only declares dependencies.

plugins {
    id("com.android.application") version "8.3.2" apply false
    id("org.jetbrains.kotlin.android") version "1.9.22" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "1.9.22" apply false
    id("org.jetbrains.kotlin.plugin.serialization") version "1.9.22" apply false
    id("com.google.devtools.ksp") version "1.9.22-1.0.17" apply false
}
