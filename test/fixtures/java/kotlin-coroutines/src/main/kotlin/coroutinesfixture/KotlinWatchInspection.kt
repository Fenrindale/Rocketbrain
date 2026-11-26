package coroutinesfixture

import java.nio.file.Files
import java.nio.file.Path
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.jdbc.datasource.DriverManagerDataSource

class WatchSideEffect {
    var calls = 0
    fun mutate(): Int { calls++; return calls }
}

private class WatchTrapList(private val side: WatchSideEffect) : AbstractList<Int>() {
    override val size: Int get() = side.mutate()
    override fun get(index: Int): Int = side.mutate()
}

private class WatchTrapKey(private val side: WatchSideEffect, private val nonce: Int) {
    override fun hashCode(): Int { side.mutate(); return 31 }
    override fun equals(other: Any?): Boolean { side.mutate(); return other === this }
    override fun toString(): String { side.mutate(); return "opaque-" + nonce }
}

private class WatchTrapMap(private val side: WatchSideEffect) : LinkedHashMap<Any?, Any?>() {
    override val entries: MutableSet<MutableMap.MutableEntry<Any?, Any?>>
        get() { side.mutate(); return super.entries }
}

class WatchObject(private val side: WatchSideEffect) {
    var count = 4
    @JvmField var isOpen = true
    var exact = 9007199254740993L
    var nullable: Int? = null
    var freshInt: Int? = null
    var freshLong: Long? = null
    var freshFlag: Boolean? = null
    var freshRace: Int? = null
    var guardedBox: Int? = null
        set(value) { side.mutate(); field = value }
    val storedBox: Int? = 7
    val constant = 13
    var label = "original"
    val knownSupplementary = "fixture🙂"
    var optionalLabel: String? = null
    val largeLabel = "x".repeat(5000)
    var guardedLabel = "custom"
        set(value) { side.mutate(); field = value }
    val history = IntArray(70) { it + 10 }
    var changingHistory = intArrayOf(11, 22, 33)
    val preciseHistory = longArrayOf(9007199254740993L, 7L)
    val bits = booleanArrayOf(true, false)
    val guardedArray = intArrayOf(9)
        get() { side.mutate(); return field }
    var guarded = 11
        set(value) { side.mutate(); field = value }
    var computed: Int
        get() = side.mutate()
        set(value) { if (value > 0) side.mutate() }
    val delegated by lazy { side.mutate() }
    companion object { @JvmField var global = 1 }
}

object KotlinWatchInspection {
    private fun observedEntries(amount: Int, side: WatchSideEffect): LinkedHashMap<Any?, Any?> {
        // Force hash-bin tree nodes, while the public encounter order remains the same as insertion.
        val tree = LinkedHashMap<WatchTrapKey, Int>(64)
        for (index in 0..11) tree[WatchTrapKey(side, index)] = index
        val map = LinkedHashMap<Any?, Any?>()
        map["database"] = amount
        map[null] = null
        map["precision"] = 9007199254740999L
        map[false] = true
        map["unicode🙂"] = "fixture🙂"
        val nested = ArrayList<Any?>()
        nested.add(null)
        nested.add(arrayOf<Any?>("label", 9007199254740997L))
        val inside = LinkedHashMap<String, Boolean>()
        inside["inside"] = false
        nested.add(inside)
        map["nested"] = nested
        map["cycle"] = map
        map["trap"] = WatchTrapList(side)
        map["tree"] = tree
        for (index in 9..74) map[index] = "key-" + index
        // Clear only the normal application writes' known hash/equals calls before pause.
        side.calls = 0
        return map
    }

    private fun allowFixtureFieldChange(target: WatchObject, map: MutableMap<Any?, Any?>) {
        val signalName = System.getenv("RB_KOTLIN_TEST_FIELD_SIGNAL") ?: return
        val signal = Path.of(signalName)
        val worker = Thread {
            val deadline = System.nanoTime() + 50_000_000_000L
            var countChanged = false
            var arrayChanged = false
            var elementChanged = false
            var boxChanged = false
            var mapChanged = false
            var mapValueChanged = false
            while (System.nanoTime() < deadline) {
                if (!countChanged && Files.isRegularFile(signal)) {
                    target.count = 34
                    countChanged = true
                    println("Rocketbrain Kotlin field changed by fixture")
                }
                if (!arrayChanged && Files.isRegularFile(Path.of(signalName + ".array"))) {
                    target.changingHistory = target.changingHistory.copyOf()
                    arrayChanged = true
                    println("Rocketbrain Kotlin array replaced by fixture")
                }
                if (!elementChanged && Files.isRegularFile(Path.of(signalName + ".element"))) {
                    target.changingHistory[1] = 23
                    elementChanged = true
                    println("Rocketbrain Kotlin array element changed by fixture")
                }
                if (!boxChanged && Files.isRegularFile(Path.of(signalName + ".box"))) {
                    target.freshRace = 771
                    boxChanged = true
                    println("Rocketbrain Kotlin boxed field changed by fixture")
                }
                if (!mapValueChanged && Files.isRegularFile(Path.of(signalName + ".map-value"))) {
                    map["database"] = 83
                    mapValueChanged = true
                    println("Rocketbrain Kotlin map value changed by fixture")
                }
                if (!mapChanged && Files.isRegularFile(Path.of(signalName + ".map"))) {
                    map["added"] = true
                    mapChanged = true
                    println("Rocketbrain Kotlin map structure changed by fixture")
                }
                Thread.sleep(25)
            }
        }
        worker.isDaemon = true
        worker.start()
    }

    @JvmStatic
    fun main(args: Array<String>) {
        val jdbc = JdbcTemplate(DriverManagerDataSource(
            requireNotNull(System.getenv("RB_COROUTINE_JDBC_URL")),
            requireNotNull(System.getenv("RB_COROUTINE_JDBC_USER")),
            requireNotNull(System.getenv("RB_COROUTINE_JDBC_PASSWORD"))
        ))
        val input = System.`in`.bufferedReader()
        println("Rocketbrain coroutine fixture ready")
        while (input.readLine() == "inspect") {
            val amount = requireNotNull(jdbc.queryForObject("SELECT 42", Int::class.javaObjectType))
            val caption = jdbc.queryForObject("SELECT 'receipt'", String::class.java)
            val missing = jdbc.queryForObject("SELECT CAST(NULL AS CHAR)", String::class.java)
            val boxed: Int? = jdbc.queryForObject("SELECT 7", Int::class.javaObjectType)
            val version = jdbc.queryForObject("SELECT VERSION()", String::class.java)
            val side = WatchSideEffect()
            val numbers = intArrayOf(amount, requireNotNull(boxed))
            val captions = listOf(caption, null, "edge")
            val mutable = arrayListOf(boxed, amount)
            val singleton = java.util.Collections.singletonList<Long?>(null)
            val immutable = java.util.List.of(9007199254740993L, 3L, 5L)
            val nested = arrayOf(numbers, intArrayOf(0))
            val target = WatchObject(side)
            val map = observedEntries(amount, side)
            val oversized = LinkedHashMap<Int, Int>()
            for (index in 0..128) oversized[index] = index
            val accessOrdered = LinkedHashMap<Any?, Any?>(4, 0.75f, true)
            val unsupported = WatchTrapMap(side)
            val unordered = HashMap<String, Int>()
            allowFixtureFieldChange(target, map)
            paused(amount, 9007199254740993L, caption, missing, boxed, true, side,
                numbers, captions, mutable, singleton, immutable, nested, null, WatchTrapList(side), target, WatchObject(side), 113,
                map, oversized, accessOrdered, unsupported, unordered)
            println("Rocketbrain Kotlin JDBC|" + version + "|" + amount + "|" + side.calls)
        }
    }

    @JvmStatic
    fun paused(amount: Int, large: Long, caption: String?, missing: String?, boxed: Int?, enabled: Boolean,
               side: WatchSideEffect, numbers: IntArray, captions: List<String?>, mutable: List<Int?>,
               singleton: List<Long?>, immutable: List<Long>, nested: Array<IntArray>, absentList: List<Int>?, trap: List<Int>,
               target: WatchObject, other: WatchObject, replacementBox: Int?, orderedMap: Map<Any?, Any?>,
               oversizedMap: Map<Int, Int>, accessOrderMap: Map<Any?, Any?>, customMap: Map<Any?, Any?>,
               unorderedMap: Map<String, Int>) {
        val subtotal = amount + 2 * 3
        val precise = large + amount
        val length = caption?.length ?: 0
        val fallback = missing?.length ?: amount + 1
        val boolean = enabled && caption == "receipt" && boxed == 7
        check(numbers[0] == amount && captions[1] == null && mutable[1] == amount)
        check(singleton.size == 1 && immutable.size == 3 && nested[0] === numbers && absentList == null)
        check(trap is WatchTrapList)
        check(side.calls == 0)
        check(replacementBox == 113)
        check(oversizedMap.size == 129 && accessOrderMap.isEmpty() && customMap.isEmpty() && unorderedMap.isEmpty())
        println("Rocketbrain Kotlin Fields|" + target.count + "|" + target.isOpen + "|" + target.exact + "|" +
            target.nullable + "|" + other.count + "|" + side.calls)
        val labelBytes = target.label.toByteArray(Charsets.UTF_8).joinToString("") { (it.toInt() and 255).toString(16).padStart(2, '0') }
        println("Rocketbrain Kotlin Field Values|" + labelBytes + "|" + target.optionalLabel + "|" +
            target.history[65] + "|" + target.preciseHistory[0] + "|" + target.bits[1] + "|" +
            other.label + "|" + other.history[65] + "|" + side.calls)
        val cachedFalse: Any = false
        println("Rocketbrain Kotlin Fresh Boxes|" + target.freshInt + "|" + target.freshLong + "|" + target.freshFlag +
            "|" + ((target.freshFlag as Any?) !== cachedFalse) + "|" + other.freshInt + "|" + other.freshLong + "|" +
            other.freshFlag + "|" + side.calls)
        println("Rocketbrain Kotlin Ordered Map|" + orderedMap.size + "|" + orderedMap["database"] + "|" + side.calls)
        println("Rocketbrain Kotlin evaluated|" + subtotal + "|" + precise + "|" + length + "|" + fallback + "|" + boolean)
    }
}
