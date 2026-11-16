package com.blokblok.arena.game

// BLOCKADE ARENA — native Canvas board renderer (dark graphite neon, spec §13).
// Kotlin port of apps/web/src/game/render.ts.
//
// Animation contract (user quality bar):
// - Driven ONLY by the display frame clock (withFrameNanos in the screen) —
//   never by timers, Handler posts, or LaunchedEffect delays.
// - Orbs NEVER teleport: every cell change starts a 150 ms easeOutCubic glide
//   from the current display position to the new cell, with a motion trail.
// - Blockades grow in centre-out over 250 ms (easeOutCubic) + glow pulse +
//   particle burst; they never pop in instantly.
// - Per-frame work is light: grid + background are pre-rendered once per
//   resize into an offscreen bitmap, orb sprites once per colour, particles
//   are a fixed pool — no allocation in the draw loop.

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Canvas
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.nativeCanvas
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.random.Random

data class Preview(val edge: Edge, val valid: Boolean)

private data class Glide(
    val fromRow: Float,
    val fromCol: Float,
    val toRow: Int,
    val toCol: Int,
    val startMs: Long,
    val durMs: Long,
)

private class Particle(
    var x: Float = 0f,
    var y: Float = 0f,
    var vx: Float = 0f,
    var vy: Float = 0f,
    var life: Float = 0f,
    var maxLife: Float = 1f,
    var size: Float = 2f,
    var color: Color = Color.White,
    var alive: Boolean = false,
)

private const val MAX_PARTICLES = 256
private const val TRAIL_LEN = 10

private data class OrbPalette(val core: Color, val mid: Color, val glow: Color, val dark: Color)

private val BLUE = OrbPalette(
    core = Color(0xFF7DD3FC),
    mid = Color(0xFF38BDF8),
    glow = Color(0xFF0EA5E9),
    dark = Color(0xFF0369A1),
)
private val RED = OrbPalette(
    core = Color(0xFFFDA4AF),
    mid = Color(0xFFFB7185),
    glow = Color(0xFFF43F5E),
    dark = Color(0xFF9F1239),
)
private val GREEN = OrbPalette(
    core = Color(0xFF86EFAC),
    mid = Color(0xFF22C55E),
    glow = Color(0xFF16A34A),
    dark = Color(0xFF14532D),
)
private val AMBER = OrbPalette(
    core = Color(0xFFFDE68A),
    mid = Color(0xFFF59E0B),
    glow = Color(0xFFD97706),
    dark = Color(0xFF78350F),
)

/** Orb palette for a player colour (P1 blue, P2 red, P3 green, P4 amber). */
private fun paletteFor(color: PlayerColor): OrbPalette = when (color) {
    PlayerColor.BLUE -> BLUE
    PlayerColor.RED -> RED
    PlayerColor.GREEN -> GREEN
    PlayerColor.AMBER -> AMBER
}

private val GOLD = Color(0xFFFFD700)
private val GOLD_DEEP = Color(0xFFF59E0B)

class BoardRenderer {
    private var bg: ImageBitmap? = null
    private var sizePx: Float = 0f
    private var cell: Float = 0f
    private var originX: Float = 0f
    private var originY: Float = 0f
    private var n: Int = DEFAULT_GRID_SIZE

    private val sprites = HashMap<PlayerColor, ImageBitmap>()
    private val display = HashMap<String, Pair<Float, Float>>()
    private val glides = HashMap<String, Glide>()
    private val trails = HashMap<String, ArrayDeque<Pair<Float, Float>>>()
    private val lastDir = HashMap<String, Pair<Float, Float>>()
    private val blockadeSeen = HashMap<String, Long>()
    private val particles = Array(MAX_PARTICLES) { Particle() }
    private var prevSnap: Snapshot? = null
    private var shakeUntilMs: Long = 0
    private var shakeMag: Float = 0f
    private var winBurstDoneFor: String? = null

    val gridSize: Int get() = n

    /** Start an optimistic glide (local prediction): the orb glides to the
     *  target cell now; the next authoritative snapshot reconciles it. */
    fun startGlide(playerId: String, toRow: Int, toCol: Int, nowMs: Long) {
        val from = displayPosition(playerId, nowMs)
        if (kotlin.math.round(from.first).toInt() == toRow && kotlin.math.round(from.second).toInt() == toCol) return
        glides[playerId] = Glide(from.first, from.second, toRow, toCol, nowMs, MOVE_ANIM_MS)
    }

    /** Recompute geometry + pre-render the static background. Call on resize. */
    fun resize(sizePx: Float, gridSize: Int) {
        this.sizePx = sizePx
        this.n = gridSize
        val pad = max(8f, sizePx * 0.02f)
        cell = (sizePx - pad * 2) / gridSize
        originX = pad
        originY = pad
        // Static background: graphite + grid + goal-row base tints + border.
        val bmp = ImageBitmap(sizePx.toInt().coerceAtLeast(1), sizePx.toInt().coerceAtLeast(1))
        val canvas = Canvas(bmp)
        val w = sizePx
        // Diagonal graphite gradient.
        val grad = Brush.linearGradient(
            colors = listOf(Color(0xFF11161D), Color(0xFF0A0E14), Color(0xFF0D1117)),
            start = Offset(0f, 0f),
            end = Offset(w, w),
        )
        canvas.drawRect(Offset.Zero, Size(w, w), androidx.compose.ui.graphics.Paint().apply { shader = grad })
        // Goal rows (static base tint; the pulse is drawn live).
        canvas.drawRect(
            Offset(originX, originY), Size(cell * gridSize, cell),
            androidx.compose.ui.graphics.Paint().apply { color = Color(0xFF22D3EE).copy(alpha = 0.10f) },
        )
        canvas.drawRect(
            Offset(originX, originY + cell * (gridSize - 1)), Size(cell * gridSize, cell),
            androidx.compose.ui.graphics.Paint().apply { color = Color(0xFFF43F5E).copy(alpha = 0.10f) },
        )
        // Grid lines.
        val linePaint = androidx.compose.ui.graphics.Paint().apply {
            color = Color(0xFF94A3B8).copy(alpha = 0.20f)
            strokeWidth = 1f
        }
        for (i in 0..gridSize) {
            val p = originX + i * cell
            canvas.drawLine(Offset(p, originY), Offset(p, originY + cell * gridSize), linePaint)
            val q = originY + i * cell
            canvas.drawLine(Offset(originX, q), Offset(originX + cell * gridSize, q), linePaint)
        }
        // Board border glow.
        val borderPaint = androidx.compose.ui.graphics.Paint().apply {
            color = Color(0xFF22D3EE).copy(alpha = 0.45f)
            strokeWidth = 2f
            style = androidx.compose.ui.graphics.PaintingStyle.Stroke
        }
        canvas.drawRect(
            Offset(originX - 1, originY - 1), Size(cell * gridSize + 2, cell * gridSize + 2), borderPaint,
        )
        bg = bmp
        // Orb sprites (once per colour).
        sprites[PlayerColor.BLUE] = makeOrbSprite(BLUE)
        sprites[PlayerColor.RED] = makeOrbSprite(RED)
        sprites[PlayerColor.GREEN] = makeOrbSprite(GREEN)
        sprites[PlayerColor.AMBER] = makeOrbSprite(AMBER)
    }

    private fun makeOrbSprite(pal: OrbPalette): ImageBitmap {
        val s = 128
        val bmp = ImageBitmap(s, s)
        val canvas = Canvas(bmp)
        val cx = s / 2f
        val cy = s / 2f
        // Outer glow.
        val glow = Brush.radialGradient(
            colors = listOf(pal.glow, pal.mid.copy(alpha = 0.8f), Color.Transparent),
            center = Offset(cx, cy), radius = 62f,
        )
        canvas.drawRect(
            Offset.Zero, Size(s.toFloat(), s.toFloat()),
            androidx.compose.ui.graphics.Paint().apply { shader = glow },
        )
        // Body.
        val body = Brush.radialGradient(
            colors = listOf(Color.White, pal.core, pal.mid, pal.dark),
            center = Offset(cx - 10, cy - 12), radius = 34f,
        )
        canvas.drawCircle(
            Offset(cx, cy), 32f,
            androidx.compose.ui.graphics.Paint().apply { shader = body },
        )
        // Bright rim.
        canvas.drawCircle(
            Offset(cx, cy), 31f,
            androidx.compose.ui.graphics.Paint().apply {
                color = Color.White.copy(alpha = 0.9f)
                style = androidx.compose.ui.graphics.PaintingStyle.Stroke
                strokeWidth = 2.5f
            },
        )
        // Inner energy swirl (static part; rotation is drawn live as an arc).
        val swirl = androidx.compose.ui.graphics.Paint().apply {
            color = Color.White.copy(alpha = 0.55f)
            style = androidx.compose.ui.graphics.PaintingStyle.Stroke
            strokeWidth = 3f
        }
        val native = canvas.nativeCanvas
        native.drawArc(cx - 18, cy - 18, cx + 18, cy + 18, 34f, 103f, false, swirl.asFrameworkPaint())
        native.drawArc(cx - 18, cy - 18, cx + 18, cy + 18, 214f, 103f, false, swirl.asFrameworkPaint())
        // Hot core.
        val core = Brush.radialGradient(
            colors = listOf(Color.White, Color.Transparent),
            center = Offset(cx, cy), radius = 10f,
        )
        canvas.drawCircle(
            Offset(cx, cy), 10f,
            androidx.compose.ui.graphics.Paint().apply { shader = core },
        )
        return bmp
    }

    /** Fractional cell coordinates of a point in pixels relative to the board. */
    fun pointToCell(px: Float, py: Float): Pair<Float, Float> =
        (px - originX) / cell to (py - originY) / cell

    fun cellCenter(row: Float, col: Float): Offset =
        Offset(originX + (col + 0.5f) * cell, originY + (row + 0.5f) * cell)

    /** Feed the latest authoritative snapshot. Starts glides / bursts on change. */
    fun setSnapshot(snap: Snapshot, nowMs: Long) {
        n = snap.gridSize
        val prev = prevSnap
        for (p in snap.players) {
            val cur = display[p.id]
            if (cur == null) {
                display[p.id] = p.row.toFloat() to p.col.toFloat()
                trails[p.id] = ArrayDeque()
                continue
            }
            if (cur.first.toInt() != p.row || cur.second.toInt() != p.col) {
                val prevCell = prev?.players?.find { it.id == p.id }
                val jumped = prevCell != null &&
                    kotlin.math.abs(p.row - prevCell.row) + kotlin.math.abs(p.col - prevCell.col) > 1
                if (jumped) {
                    // Resync (reconnect / big correction): snap, never glide across the board.
                    display[p.id] = p.row.toFloat() to p.col.toFloat()
                    glides.remove(p.id)
                } else {
                    val from = displayPosition(p.id, nowMs)
                    glides[p.id] = Glide(from.first, from.second, p.row, p.col, nowMs, MOVE_ANIM_MS)
                    lastDir[p.id] = (p.row - kotlin.math.round(from.first)).toFloat() to
                        (p.col - kotlin.math.round(from.second)).toFloat()
                }
            }
        }
        for (b in snap.blockades) {
            if (!blockadeSeen.containsKey(b.id)) {
                blockadeSeen[b.id] = nowMs
                for (e in b.edges) {
                    val c = edgeCenter(e)
                    burst(c.x, c.y, Color(0xFF22D3EE), 6)
                }
            }
        }
        if (snap.winnerId != null && winBurstDoneFor != snap.winnerId) {
            winBurstDoneFor = snap.winnerId
            val w = snap.players.find { it.id == snap.winnerId }
            if (w != null) {
                val c = cellCenter(w.row.toFloat(), w.col.toFloat())
                val pal = paletteFor(w.color)
                burst(c.x, c.y, pal.glow, 60)
                burst(c.x, c.y, Color.White, 30)
                if (snap.mode == GameMode.TROPHY) {
                    // Trophy capture: gold burst at the trophy cell itself.
                    val t = snap.trophy ?: trophyCellFor(snap.gridSize)
                    val tc = cellCenter(t.row.toFloat(), t.col.toFloat())
                    burst(tc.x, tc.y, GOLD, 80)
                    burst(tc.x, tc.y, Color.White, 40)
                }
            }
        }
        prevSnap = snap
    }

    /** Collision feedback: sparks at the orb + a tiny screen shake. */
    fun collide(playerId: String, nowMs: Long) {
        val d = display[playerId] ?: return
        val c = cellCenter(d.first, d.second)
        burst(c.x, c.y, Color(0xFFFBBF24), 10)
        shakeUntilMs = nowMs + 140
        shakeMag = 2.5f
    }

    private fun edgeCenter(e: Edge): Offset {
        return if (e.orientation == Orientation.H) {
            Offset(originX + (e.col + e.len / 2f) * cell, originY + e.row * cell)
        } else {
            Offset(originX + e.col * cell, originY + (e.row + e.len / 2f) * cell)
        }
    }

    private fun burst(x: Float, y: Float, color: Color, count: Int) {
        var spawned = 0
        for (pt in particles) {
            if (spawned >= count) break
            if (pt.alive) continue
            val a = Random.nextFloat() * 2f * PI.toFloat()
            val sp = 40f + Random.nextFloat() * 160f
            pt.x = x
            pt.y = y
            pt.vx = cos(a) * sp
            pt.vy = sin(a) * sp
            pt.maxLife = 0.35f + Random.nextFloat() * 0.45f
            pt.life = pt.maxLife
            pt.size = 1.5f + Random.nextFloat() * 2.5f
            pt.color = color
            pt.alive = true
            spawned++
        }
    }

    /** Current interpolated display position (advances glides to [nowMs]). */
    fun displayPosition(playerId: String, nowMs: Long): Pair<Float, Float> {
        val g = glides[playerId]
        val cur = display[playerId] ?: (0f to 0f)
        if (g == null) return cur
        val t = min(1f, (nowMs - g.startMs).toFloat() / g.durMs)
        if (t >= 1f) {
            display[playerId] = g.toRow.toFloat() to g.toCol.toFloat()
            glides.remove(playerId)
            return g.toRow.toFloat() to g.toCol.toFloat()
        }
        val e = easeOutCubic(t)
        return (g.fromRow + (g.toRow - g.fromRow) * e) to (g.fromCol + (g.toCol - g.fromCol) * e)
    }

    /** Draw one frame. Must be called from inside a Compose Canvas DrawScope,
     *  once per display frame (withFrameNanos). */
    fun draw(scope: DrawScope, snap: Snapshot, nowMs: Long, dtMs: Long, preview: Preview?) {
        val s = sizePx
        with(scope) {
            // Screen shake (collision feedback).
            val shakeDx: Float
            val shakeDy: Float
            if (nowMs < shakeUntilMs) {
                val m = shakeMag * ((shakeUntilMs - nowMs).toFloat() / 140f)
                shakeDx = (Random.nextFloat() - 0.5f) * m * 2f
                shakeDy = (Random.nextFloat() - 0.5f) * m * 2f
            } else {
                shakeDx = 0f
                shakeDy = 0f
            }
            withTransform({ translate(shakeDx, shakeDy) }) {
                bg?.let { drawImage(it, dstSize = Size(s, s)) }

                // Goal-row pulse (race mode only — trophy mode has no goal rows).
                if (snap.mode == GameMode.RACE) {
                    val pulse = 0.05f + 0.04f * sin(nowMs / 450f)
                    drawRect(Color(0xFF22D3EE).copy(alpha = pulse), Offset(originX, originY), Size(cell * n, cell))
                    drawRect(
                        Color(0xFFF43F5E).copy(alpha = pulse),
                        Offset(originX, originY + cell * (n - 1)), Size(cell * n, cell),
                    )
                }

                // Trophy (trophy mode): gold trophy at the centre cell.
                if (snap.mode == GameMode.TROPHY) {
                    val t = snap.trophy ?: trophyCellFor(snap.gridSize)
                    drawTrophy(t, nowMs)
                }

                // Blockades (grow-in + glow pulse).
                for (b in snap.blockades) {
                    val seenAt = blockadeSeen[b.id] ?: nowMs
                    val prog = easeOutCubic(min(1f, (nowMs - seenAt).toFloat() / DEPLOY_MS))
                    val glowPulse = 0.75f + 0.25f * sin(nowMs / 300f + seenAt)
                    for (e in b.edges) drawEdge(e, prog, glowPulse)
                }

                // Drag preview.
                if (preview != null) drawPreview(preview, nowMs)

                // Orbs + trails.
                for (p in snap.players) {
                    val pos = displayPosition(p.id, nowMs)
                    pushTrail(p.id, pos)
                    drawTrail(p, pos)
                    drawOrb(p, pos, nowMs)
                }

                // Particles (additive).
                for (pt in particles) {
                    if (!pt.alive) continue
                    pt.life -= dtMs / 1000f
                    if (pt.life <= 0f) {
                        pt.alive = false
                        continue
                    }
                    pt.x += pt.vx * (dtMs / 1000f)
                    pt.y += pt.vy * (dtMs / 1000f)
                    pt.vx *= 0.96f
                    pt.vy *= 0.96f
                    val a = max(0f, pt.life / pt.maxLife)
                    drawCircle(pt.color.copy(alpha = a), pt.size * (0.5f + a * 0.5f), Offset(pt.x, pt.y))
                }
            }
        }
    }

    private fun DrawScope.pushTrail(playerId: String, pos: Pair<Float, Float>) {
        val t = trails[playerId] ?: return
        val last = t.lastOrNull()
        if (last != null && kotlin.math.abs(last.first - pos.first) < 0.01f && kotlin.math.abs(last.second - pos.second) < 0.01f) return
        t.addLast(pos)
        if (t.size > TRAIL_LEN) t.removeFirst()
    }

    private fun DrawScope.drawTrail(p: PlayerState, @Suppress("UNUSED_PARAMETER") pos: Pair<Float, Float>) {
        val t = trails[p.id] ?: return
        if (t.size < 2) return
        val pal = paletteFor(p.color)
        for (i in 0 until t.size - 1) {
            val a = (i.toFloat() / t.size) * 0.28f
            val c = cellCenter(t[i].first, t[i].second)
            drawCircle(pal.glow.copy(alpha = a), cell * 0.22f * (0.4f + (i.toFloat() / t.size) * 0.6f), c)
        }
    }

    private fun DrawScope.drawOrb(p: PlayerState, pos: Pair<Float, Float>, nowMs: Long) {
        val c = cellCenter(pos.first, pos.second)
        val pal = paletteFor(p.color)
        val pulse = 1f + 0.05f * sin(nowMs / 280f + if (p.color == PlayerColor.BLUE) 0f else PI.toFloat())
        val r = cell * 0.52f * pulse
        val moving = glides.containsKey(p.id)
        val spriteR = r * (if (moving) 1.12f else 1.05f)
        val sprite = sprites[p.color]
        if (sprite != null) {
            drawImage(
                sprite,
                dstOffset = Offset(c.x - spriteR, c.y - spriteR),
                dstSize = Size(spriteR * 2, spriteR * 2),
            )
        } else {
            drawCircle(pal.mid, r, c)
        }
        // Rotating energy arc (live — cheap stroke).
        val rot = nowMs / 500f
        drawArc(
            Color.White.copy(alpha = 0.75f),
            startAngle = Math.toDegrees(rot.toDouble()).toFloat(),
            sweepAngle = 109f,
            useCenter = false,
            topLeft = Offset(c.x - r * 0.62f, c.y - r * 0.62f),
            size = Size(r * 1.24f, r * 1.24f),
            style = Stroke(width = max(1.5f, cell * 0.045f)),
        )
        drawArc(
            Color.White.copy(alpha = 0.75f),
            startAngle = Math.toDegrees(rot.toDouble()).toFloat() + 180f,
            sweepAngle = 109f,
            useCenter = false,
            topLeft = Offset(c.x - r * 0.62f, c.y - r * 0.62f),
            size = Size(r * 1.24f, r * 1.24f),
            style = Stroke(width = max(1.5f, cell * 0.045f)),
        )
        // Direction indicator.
        val d = lastDir[p.id]
        if (d != null && (d.first != 0f || d.second != 0f)) {
            val ang = kotlin.math.atan2(d.first, d.second)
            val tx = c.x + cos(ang) * r * 1.15f
            val ty = c.y + sin(ang) * r * 1.15f
            val tri = androidx.compose.ui.graphics.Path().apply {
                moveTo(tx + cos(ang) * 6f, ty + sin(ang) * 6f)
                lineTo(tx + cos(ang + 2.5f) * 6f, ty + sin(ang + 2.5f) * 6f)
                lineTo(tx + cos(ang - 2.5f) * 6f, ty + sin(ang - 2.5f) * 6f)
                close()
            }
            drawPath(tri, pal.core)
        }
    }

    /** Gold trophy at the centre cell (trophy mode, canvas-drawn — no image
     *  assets). Halo glow + idle pulse (the cup breathes) + orbiting
     *  sparkle stars + an occasional gold particle; the win burst on
     *  capture is fired from setSnapshot. */
    private fun DrawScope.drawTrophy(trophy: TrophyCell, nowMs: Long) {
        val c = cellCenter(trophy.row.toFloat(), trophy.col.toFloat())
        val pulse = 1f + 0.06f * sin(nowMs / 400f)
        val r = cell * 0.42f * pulse
        // Halo glow (breathes with the same pulse).
        drawCircle(GOLD.copy(alpha = 0.16f + 0.06f * sin(nowMs / 400f)), r * 1.45f, c)
        drawCircle(GOLD_DEEP.copy(alpha = 0.22f), r * 1.15f, c)
        // Cup bowl.
        val bowl = androidx.compose.ui.graphics.Path().apply {
            moveTo(c.x - r * 0.62f, c.y - r * 0.55f)
            lineTo(c.x + r * 0.62f, c.y - r * 0.55f)
            cubicTo(c.x + r * 0.55f, c.y + r * 0.05f, c.x + r * 0.35f, c.y + r * 0.35f, c.x + r * 0.14f, c.y + r * 0.38f)
            lineTo(c.x - r * 0.14f, c.y + r * 0.38f)
            cubicTo(c.x - r * 0.35f, c.y + r * 0.35f, c.x - r * 0.55f, c.y + r * 0.05f, c.x - r * 0.62f, c.y - r * 0.55f)
            close()
        }
        drawPath(bowl, GOLD)
        // Rim highlight.
        drawLine(
            Color.White.copy(alpha = 0.85f),
            Offset(c.x - r * 0.55f, c.y - r * 0.52f), Offset(c.x + r * 0.55f, c.y - r * 0.52f),
            strokeWidth = max(2f, cell * 0.05f),
            cap = androidx.compose.ui.graphics.StrokeCap.Round,
        )
        // Handles (arcs on both sides of the bowl).
        drawArc(
            GOLD_DEEP, startAngle = -90f, sweepAngle = 180f, useCenter = false,
            topLeft = Offset(c.x + r * 0.42f, c.y - r * 0.45f), size = Size(r * 0.55f, r * 0.6f),
            style = Stroke(width = max(2f, cell * 0.06f)),
        )
        drawArc(
            GOLD_DEEP, startAngle = 90f, sweepAngle = 180f, useCenter = false,
            topLeft = Offset(c.x - r * 0.97f, c.y - r * 0.45f), size = Size(r * 0.55f, r * 0.6f),
            style = Stroke(width = max(2f, cell * 0.06f)),
        )
        // Stem + base.
        drawLine(
            GOLD_DEEP, Offset(c.x, c.y + r * 0.38f), Offset(c.x, c.y + r * 0.62f),
            strokeWidth = max(2f, cell * 0.07f),
            cap = androidx.compose.ui.graphics.StrokeCap.Round,
        )
        drawLine(
            GOLD, Offset(c.x - r * 0.38f, c.y + r * 0.68f), Offset(c.x + r * 0.38f, c.y + r * 0.68f),
            strokeWidth = max(2.5f, cell * 0.09f),
            cap = androidx.compose.ui.graphics.StrokeCap.Round,
        )
        // Star on the bowl.
        drawStar(c.x, c.y - r * 0.12f, r * 0.16f, Color.White.copy(alpha = 0.95f))
        // Sparkles: 4-point stars orbiting the trophy, alpha pulsing.
        for (i in 0 until 5) {
            val ang = nowMs / 900f + i * (2f * PI.toFloat() / 5f)
            val dist = r * (1.05f + 0.15f * sin(nowMs / 500f + i * 1.7f))
            val sx = c.x + cos(ang) * dist
            val sy = c.y + sin(ang) * dist * 0.9f
            val a = 0.35f + 0.45f * (0.5f + 0.5f * sin(nowMs / 300f + i * 2.1f))
            drawStar(sx, sy, cell * 0.07f, Color.White.copy(alpha = a))
        }
        // Occasional gold sparkle particle (fixed pool, no allocation).
        if (Random.nextFloat() < 0.25f) {
            burst(c.x + (Random.nextFloat() - 0.5f) * r, c.y + (Random.nextFloat() - 0.5f) * r, GOLD, 1)
        }
    }

    /** 4-point star (two crossed lines) centred at (x, y). */
    private fun DrawScope.drawStar(x: Float, y: Float, half: Float, color: Color) {
        drawLine(
            color, Offset(x - half, y), Offset(x + half, y),
            strokeWidth = max(1.5f, half * 0.35f),
            cap = androidx.compose.ui.graphics.StrokeCap.Round,
        )
        drawLine(
            color, Offset(x, y - half), Offset(x, y + half),
            strokeWidth = max(1.5f, half * 0.35f),
            cap = androidx.compose.ui.graphics.StrokeCap.Round,
        )
    }

    private fun DrawScope.drawEdge(e: Edge, prog: Float, glowPulse: Float) {
        if (prog <= 0f) return
        // Centre-out growth: draw the middle `prog` fraction of the segment.
        val x0 = originX + e.col * cell
        val y0 = originY + e.row * cell
        val (ax, ay, bx, by) = if (e.orientation == Orientation.H) {
            val cx = x0 + (cell * e.len) / 2f
            val half = (cell * e.len * prog) / 2f
            arrayOf(cx - half, y0, cx + half, y0)
        } else {
            val cy = y0 + (cell * e.len) / 2f
            val half = (cell * e.len * prog) / 2f
            arrayOf(x0, cy - half, x0, cy + half)
        }
        // Outer glow.
        drawLine(
            Color(0xFF22D3EE).copy(alpha = 0.35f * glowPulse),
            Offset(ax, ay), Offset(bx, by), strokeWidth = cell * 0.34f,
            cap = androidx.compose.ui.graphics.StrokeCap.Round,
        )
        // Bright core.
        drawLine(
            Color(0xFFECFEFF).copy(alpha = 0.95f),
            Offset(ax, ay), Offset(bx, by), strokeWidth = cell * 0.13f,
            cap = androidx.compose.ui.graphics.StrokeCap.Round,
        )
    }

    private fun DrawScope.drawPreview(preview: Preview, nowMs: Long) {
        val e = preview.edge
        val x0 = originX + e.col * cell
        val y0 = originY + e.row * cell
        val x1 = if (e.orientation == Orientation.H) x0 + cell * e.len else x0
        val y1 = if (e.orientation == Orientation.V) y0 + cell * e.len else y0
        val color = if (preview.valid) Color(0xFF22FF88) else Color(0xFFFF4455)
        val dash = 6f + 3f * sin(nowMs / 150f)
        drawLine(
            color.copy(alpha = 0.9f), Offset(x0, y0), Offset(x1, y1),
            strokeWidth = cell * 0.22f,
            cap = androidx.compose.ui.graphics.StrokeCap.Round,
            pathEffect = androidx.compose.ui.graphics.PathEffect.dashPathEffect(floatArrayOf(dash, 6f), 0f),
        )
        drawCircle(color, cell * 0.14f, Offset(x0, y0))
        drawCircle(color, cell * 0.14f, Offset(x1, y1))
    }
}
