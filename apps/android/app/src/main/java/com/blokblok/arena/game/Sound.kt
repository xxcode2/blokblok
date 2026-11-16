package com.blokblok.arena.game

// BLOCKADE ARENA — tiny synthesized sound effects (no asset files).
// Tones are generated in code as WAV bytes, written once to the app cache
// dir, and loaded into SoundPool from those files: move (short blip),
// place (two-tone thunk), collision (low buzz), win (rising arpeggio).
// Muted entirely when the user toggles sound off.

import android.content.Context
import android.media.AudioAttributes
import android.media.SoundPool
import java.io.File

enum class Sfx { MOVE, PLACE, COLLIDE, WIN, ERROR }

class SoundEngine {
    private var pool: SoundPool? = null
    private val ids = HashMap<Sfx, Int>()
    private var muted = false
    private var ready = false

    fun setMuted(m: Boolean) {
        muted = m
    }

    fun init(context: Context) {
        if (ready) return
        val attrs = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_GAME)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build()
        val sp = SoundPool.Builder()
            .setMaxStreams(4)
            .setAudioAttributes(attrs)
            .build()
        pool = sp
        val dir = File(context.cacheDir, "sfx").apply { mkdirs() }
        val tones = listOf(
            Triple(Sfx.MOVE, 660.0, 60) to true,
            Triple(Sfx.PLACE, 220.0, 120) to true,
            Triple(Sfx.COLLIDE, 110.0, 140) to false,
            Triple(Sfx.WIN, 880.0, 320) to true,
            Triple(Sfx.ERROR, 160.0, 90) to false,
        )
        for ((tone, decay) in tones) {
            val (sfx, freq, ms) = tone
            val file = File(dir, "${sfx.name.lowercase()}.wav")
            if (!file.exists()) file.writeBytes(toneWav(freq, ms, decay))
            ids[sfx] = sp.load(file.absolutePath, 1)
        }
        ready = true
    }

    fun play(sfx: Sfx) {
        if (muted || !ready) return
        val id = ids[sfx] ?: return
        pool?.play(id, 0.6f, 0.6f, 1, 0, 1.0f)
    }

    fun release() {
        pool?.release()
        pool = null
        ids.clear()
        ready = false
    }

    /** Synthesize a mono 16-bit PCM tone and wrap it in a minimal WAV. */
    private fun toneWav(freq: Double, ms: Int, decay: Boolean): ByteArray {
        val rate = 22050
        val n = (rate * ms) / 1000
        val dataSize = n * 2
        val out = ByteArray(44 + dataSize)
        fun writeStr(off: Int, s: String) { s.toByteArray().copyInto(out, off) }
        fun writeInt(off: Int, v: Int) {
            out[off] = (v and 0xFF).toByte()
            out[off + 1] = ((v shr 8) and 0xFF).toByte()
            out[off + 2] = ((v shr 16) and 0xFF).toByte()
            out[off + 3] = ((v shr 24) and 0xFF).toByte()
        }
        fun writeShort(off: Int, v: Int) {
            out[off] = (v and 0xFF).toByte()
            out[off + 1] = ((v shr 8) and 0xFF).toByte()
        }
        writeStr(0, "RIFF"); writeInt(4, 36 + dataSize); writeStr(8, "WAVE")
        writeStr(12, "fmt "); writeInt(16, 16); writeShort(20, 1)
        writeShort(22, 1); writeInt(24, rate); writeInt(28, rate * 2)
        writeShort(32, 2); writeShort(34, 16)
        writeStr(36, "data"); writeInt(40, dataSize)
        for (i in 0 until n) {
            val t = i.toDouble() / rate
            val env = if (decay) (1.0 - i.toDouble() / n) else 1.0
            val v = kotlin.math.sin(2.0 * Math.PI * freq * t) * env * 0.5
            writeShort(44 + i * 2, (v * Short.MAX_VALUE).toInt())
        }
        return out
    }
}
