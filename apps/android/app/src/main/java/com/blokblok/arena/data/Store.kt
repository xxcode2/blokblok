package com.blokblok.arena.data

// BLOCKADE ARENA — persistence: DataStore for settings + player name,
// Room for match history. Both are simple, offline-first, and never block
// gameplay on IO.

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Room
import androidx.room.RoomDatabase
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

private val Context.settingsStore: DataStore<Preferences> by preferencesDataStore(name = "arena_settings")

object SettingKeys {
    val PLAYER_NAME = stringPreferencesKey("player_name")
    val SOUND_ENABLED = booleanPreferencesKey("sound_enabled")
    val HAPTICS_ENABLED = booleanPreferencesKey("haptics_enabled")
    val SERVER_URL = stringPreferencesKey("server_url")
    val GRID_SIZE = intPreferencesKey("grid_size")
    val DURATION_SEC = intPreferencesKey("duration_sec")
}

data class ArenaSettings(
    val playerName: String = "Player",
    val soundEnabled: Boolean = true,
    val hapticsEnabled: Boolean = true,
    val serverUrl: String = "ws://10.0.2.2:3001",
    val gridSize: Int = 12,
    val durationSec: Int = 180,
)

class SettingsStore(private val context: Context) {
    val settings: Flow<ArenaSettings> = context.settingsStore.data.map { prefs ->
        ArenaSettings(
            playerName = prefs[SettingKeys.PLAYER_NAME] ?: "Player",
            soundEnabled = prefs[SettingKeys.SOUND_ENABLED] ?: true,
            hapticsEnabled = prefs[SettingKeys.HAPTICS_ENABLED] ?: true,
            serverUrl = prefs[SettingKeys.SERVER_URL] ?: "ws://10.0.2.2:3001",
            gridSize = prefs[SettingKeys.GRID_SIZE] ?: 12,
            durationSec = prefs[SettingKeys.DURATION_SEC] ?: 180,
        )
    }

    suspend fun snapshot(): ArenaSettings = settings.first()

    suspend fun setPlayerName(name: String) {
        context.settingsStore.edit { it[SettingKeys.PLAYER_NAME] = name }
    }

    suspend fun setSoundEnabled(enabled: Boolean) {
        context.settingsStore.edit { it[SettingKeys.SOUND_ENABLED] = enabled }
    }

    suspend fun setHapticsEnabled(enabled: Boolean) {
        context.settingsStore.edit { it[SettingKeys.HAPTICS_ENABLED] = enabled }
    }

    suspend fun setServerUrl(url: String) {
        context.settingsStore.edit { it[SettingKeys.SERVER_URL] = url }
    }

    suspend fun setGridSize(size: Int) {
        context.settingsStore.edit { it[SettingKeys.GRID_SIZE] = size }
    }

    suspend fun setDurationSec(sec: Int) {
        context.settingsStore.edit { it[SettingKeys.DURATION_SEC] = sec }
    }
}

// ---------------------------------------------------------------------------
// Match history (Room)
// ---------------------------------------------------------------------------
@Entity(tableName = "matches")
data class MatchRecord(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val mode: String,
    val opponentName: String,
    val result: String, // WIN / LOSS / DRAW
    val durationMs: Long,
    val playedAt: Long = System.currentTimeMillis(),
)

@Dao
interface MatchDao {
    @Insert
    suspend fun insert(record: MatchRecord): Long

    @Query("SELECT * FROM matches ORDER BY playedAt DESC LIMIT 50")
    suspend fun recent(): List<MatchRecord>

    @Query("SELECT COUNT(*) FROM matches WHERE result = 'WIN'")
    suspend fun winCount(): Int

    @Query("SELECT COUNT(*) FROM matches")
    suspend fun totalCount(): Int
}

@Database(entities = [MatchRecord::class], version = 1, exportSchema = false)
abstract class ArenaDatabase : RoomDatabase() {
    abstract fun matchDao(): MatchDao

    companion object {
        @Volatile
        private var instance: ArenaDatabase? = null

        fun get(context: Context): ArenaDatabase {
            return instance ?: synchronized(this) {
                instance ?: Room.databaseBuilder(
                    context.applicationContext,
                    ArenaDatabase::class.java,
                    "blokblok-arena.db",
                ).fallbackToDestructiveMigration().build().also { instance = it }
            }
        }
    }
}
