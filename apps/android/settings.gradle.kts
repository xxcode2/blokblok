// BLOCKADE ARENA — native Android client (Kotlin + Jetpack Compose).
// Gradle settings. Requires Android Studio / Android SDK (compileSdk 34).
// Build:  ANDROID_HOME=<sdk> ./gradlew assembleDebug

pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "blockade-arena"
include(":app")
