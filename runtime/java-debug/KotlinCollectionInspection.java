package com.microsoft.java.debug.core.adapter;

import com.google.gson.JsonObject;
import com.microsoft.java.debug.core.adapter.variables.StackFrameReference;
import com.sun.jdi.BooleanValue;
import com.sun.jdi.ClassType;
import com.sun.jdi.Field;
import com.sun.jdi.IntegerValue;
import com.sun.jdi.LocalVariable;
import com.sun.jdi.ObjectReference;
import com.sun.jdi.PrimitiveValue;
import com.sun.jdi.ReferenceType;
import com.sun.jdi.StackFrame;
import com.sun.jdi.StringReference;
import com.sun.jdi.Value;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.WeakHashMap;
import java.util.concurrent.TimeUnit;

/** Coherent, bounded snapshots of exact bootstrap LinkedHashMap storage and supported nested values. */
final class KotlinCollectionInspection {
    private static final int PAGE_SIZE = 32, MAX_ENTRIES = 128, MAX_ROWS = 512, MAX_VIEWS = 32, MAX_DEPTH = 2;
    private static final int MAX_STRING = 256;
    private static final String MAP = "orderedMap", LIST = "list", ARRAY = "array";
    private static final String HASH = "Ljava/util/HashMap;", LINKED = "Ljava/util/LinkedHashMap;";
    private static final String ENTRY = "Ljava/util/LinkedHashMap$Entry;", NODE = "Ljava/util/HashMap$Node;";
    private static final String TREE_NODE = "Ljava/util/HashMap$TreeNode;", OBJECT = "Ljava/lang/Object;";
    private static final Set<String> INVALIDATING = Set.of("attach", "launch", "continue", "next", "stepIn", "stepOut",
        "stepBack", "reverseContinue", "goto", "restartFrame", "restart", "disconnect", "terminate",
        "redefineClasses", "setVariable", "setExpression");
    private static final Map<IDebugAdapterContext, Snapshot> SNAPSHOTS = new WeakHashMap<>();

    private KotlinCollectionInspection() { }

    static void invalidate(IDebugAdapterContext context, String request, JsonObject args) {
        if (request == null) return;
        boolean directWrite = ("rocketbrain/setKotlinLocal".equals(request) || "rocketbrain/kotlinObjectFields".equals(request)) &&
            "apply".equals(KotlinLocalAssignment.text(args, "action"));
        if (directWrite || INVALIDATING.contains(request)) synchronized (context) {
            synchronized (SNAPSHOTS) { SNAPSHOTS.remove(context); }
        }
    }

    private static boolean permitted(IDebugAdapterContext context, StackFrame frame) throws Exception {
        if (!KotlinObjectFields.verifiedLocalAttach(context)) return false;
        String file = frame.location().sourceName();
        return (file.endsWith(".kt") || file.endsWith(".kts")) && !frame.location().method().isObsolete() &&
            frame.virtualMachine().canBeModified();
    }

    static void list(IDebugAdapterContext context, StackFrame frame, LocalVariable local, Value value,
                     List<Map<String,Object>> result) {
        if (!(value instanceof ObjectReference) || !LINKED.equals(((ObjectReference) value).referenceType().signature())) return;
        try {
            if (!permitted(context, frame)) return;
            Ordered ordered = ordered(value);
            if (ordered != null && ordered.size <= MAX_ENTRIES) {
                result.add(Map.of("name", local.name(), "kind", MAP, "length", ordered.size));
            }
        } catch (Exception unavailable) { /* Leave other supported locals available. */ }
    }

    static Map<String,Object> read(IDebugAdapterContext context, StackFrameReference reference, StackFrame frame,
                                   int id, String name, String action, JsonObject args) throws Exception {
        synchronized (context) {
            if (!permitted(context, frame) || !KotlinLocalAssignment.isName(name)) {
                throw denied("Open a verified local Kotlin frame to inspect an ordered map.");
            }
            int start = KotlinFieldValues.index(args, "start"), count = KotlinFieldValues.index(args, "count");
            if (count < 1 || count > PAGE_SIZE) throw denied("Read at most 32 Kotlin collection entries per page.");
            LocalVariable local = frame.visibleVariableByName(name);
            if (local == null) throw stale();
            Snapshot snapshot;
            if ("mapOpen".equals(action)) {
                synchronized (SNAPSHOTS) { SNAPSHOTS.remove(context); }
                snapshot = capture(context, reference, frame, id, local);
                synchronized (SNAPSHOTS) { SNAPSHOTS.put(context, snapshot); }
                return snapshot.page(snapshot.root, start, count);
            }
            synchronized (SNAPSHOTS) { snapshot = SNAPSHOTS.get(context); }
            if (snapshot == null || !snapshot.id.equals(KotlinLocalAssignment.text(args, "snapshotId")) ||
                    snapshot.frameId != id || snapshot.reference != reference || !snapshot.frame.equals(frame) ||
                    !snapshot.local.equals(local) || System.nanoTime() - snapshot.created > TimeUnit.MINUTES.toNanos(2)) {
                throw stale();
            }
            Ordered now = ordered(frame.getValue(local));
            if (now == null || now.object.uniqueID() != snapshot.owner || now.size != snapshot.size || now.modCount != snapshot.modCount) {
                throw denied("The Kotlin map structure changed. Capture its current entries again.");
            }
            return snapshot.page(KotlinLocalAssignment.text(args, "viewId"), start, count);
        }
    }

    private static Snapshot capture(IDebugAdapterContext context, StackFrameReference reference, StackFrame frame,
                                    int id, LocalVariable local) throws Exception {
        var thread = reference.getThread();
        var vm = frame.virtualMachine();
        int suspended = thread.suspendCount();
        if (suspended < 1 || !thread.isSuspended()) throw stale();
        // Take one immutable graph snapshot while peers cannot interleave with field reads.
        vm.suspend();
        try {
            StackFrame current = context.getStackFrameManager().getStackFrame(reference);
            if (!frame.equals(current) || thread.suspendCount() != suspended + 1 || !permitted(context, current)) throw stale();
            LocalVariable selected = current.visibleVariableByName(local.name());
            if (!local.equals(selected)) throw stale();
            Ordered root = ordered(current.getValue(selected));
            if (root == null || root.size > MAX_ENTRIES) {
                throw denied("Choose an exact insertion-order LinkedHashMap with at most 128 entries.");
            }
            var builder = new Builder();
            View rootView = builder.map(root, 0, new HashSet<>());
            if (rootView == null) throw denied("The map's live entry links are unsupported or inconsistent.");
            return new Snapshot(reference, current, id, selected, root, rootView.id, builder.views);
        } finally { vm.resume(); }
    }

    private static Ordered ordered(Value candidate) {
        if (!(candidate instanceof ObjectReference)) return null;
        var object = (ObjectReference) candidate;
        if (!bootstrap(object.referenceType(), LINKED)) return null;
        var type = (ClassType) object.referenceType();
        var hash = type.superclass();
        if (!bootstrap(hash, HASH)) return null;
        Field size = field(hash, "size", "I"), mod = field(hash, "modCount", "I");
        Field access = field(type, "accessOrder", "Z"), head = field(type, "head", ENTRY), tail = field(type, "tail", ENTRY);
        if (size == null || mod == null || access == null || !access.isFinal() || head == null || tail == null) return null;
        var values = object.getValues(List.of(size, mod, access, head, tail));
        if (!(values.get(size) instanceof IntegerValue) || !(values.get(mod) instanceof IntegerValue) ||
                !(values.get(access) instanceof BooleanValue) || ((BooleanValue) values.get(access)).value()) return null;
        int count = ((IntegerValue) values.get(size)).value();
        if (count < 0) return null;
        Value first = values.get(head), last = values.get(tail);
        if (count == 0 ? first != null || last != null : !(first instanceof ObjectReference) || !(last instanceof ObjectReference)) return null;
        return new Ordered(object, count, ((IntegerValue) values.get(mod)).value(), (ObjectReference) first, (ObjectReference) last);
    }

    private static List<List<Value>> orderedPairs(Ordered map, Builder bound) {
        var entries = new ArrayList<List<Value>>();
        ObjectReference prior = null, current = map.head;
        Set<Long> visited = new HashSet<>();
        for (int index = 0; index < map.size; index++) {
            bound.deadline();
            if (current == null || !visited.add(current.uniqueID())) return null;
            ReferenceType actual = current.referenceType();
            ReferenceType entry = bootstrap(actual, TREE_NODE) ? ((ClassType) actual).superclass() : actual;
            if (!bootstrap(entry, ENTRY)) return null;
            ReferenceType node = ((ClassType) entry).superclass();
            if (!bootstrap(node, NODE)) return null;
            Field before = field(entry, "before", ENTRY), after = field(entry, "after", ENTRY);
            Field key = field(node, "key", OBJECT), value = field(node, "value", OBJECT);
            if (before == null || after == null || key == null || !key.isFinal() || value == null) return null;
            var slots = current.getValues(List.of(before, after, key, value));
            if (!same(slots.get(before), prior)) return null;
            Value following = slots.get(after);
            if (following != null && !(following instanceof ObjectReference)) return null;
            entries.add(java.util.Arrays.asList(slots.get(key), slots.get(value)));
            prior = current;
            current = (ObjectReference) following;
        }
        return current == null && same(prior, map.tail) ? entries : null;
    }

    private static boolean same(Value left, ObjectReference right) {
        return right == null ? left == null : left instanceof ObjectReference && ((ObjectReference) left).uniqueID() == right.uniqueID();
    }

    private static boolean bootstrap(ReferenceType type, String signature) {
        if (!(type instanceof ClassType) || type.classLoader() != null || !signature.equals(type.signature())) return false;
        if (!type.virtualMachine().canGetModuleInfo()) return true; // Eclipse JDI does not expose module mirrors.
        var module = type.module();
        return module != null && "java.base".equals(module.name());
    }

    private static Field field(ReferenceType type, String name, String signature) {
        Field observed = type.fieldByName(name);
        return observed != null && !observed.isStatic() && !observed.isSynthetic() && type.equals(observed.declaringType()) &&
            signature.equals(observed.signature()) ? observed : null;
    }

    private static Map<String,Object> leaf(String type, String display) {
        return Map.of("type", type, "display", display);
    }

    private static String wrapperPrimitive(String signature) {
        return Map.of("Ljava/lang/Integer;", "I", "Ljava/lang/Long;", "J", "Ljava/lang/Boolean;", "Z",
            "Ljava/lang/Double;", "D", "Ljava/lang/Float;", "F", "Ljava/lang/Character;", "C",
            "Ljava/lang/Byte;", "B", "Ljava/lang/Short;", "S").get(signature);
    }

    private static final class Builder {
        private final Map<String,View> views = new java.util.HashMap<>();
        private final long expires = System.nanoTime() + TimeUnit.SECONDS.toNanos(3);
        private int rows = MAX_ROWS, containers = MAX_VIEWS;

        void deadline() {
            if (System.nanoTime() > expires) throw denied("The Kotlin collection exceeded its snapshot time limit.");
        }

        private boolean take(int length) {
            deadline();
            if (length > MAX_ENTRIES || length > rows || containers == 0) return false;
            rows -= length;
            containers--;
            return true;
        }

        View map(Ordered mapped, int depth, Set<Long> ancestors) {
            if (mapped.size > MAX_ENTRIES || mapped.size > rows || containers == 0) return null;
            var pairs = orderedPairs(mapped, this);
            if (pairs == null || !take(pairs.size())) return null;
            ancestors.add(mapped.object.uniqueID());
            var captured = new ArrayList<Map<String,Object>>();
            try {
                for (List<Value> pair : pairs) {
                    captured.add(Map.of("index", captured.size(), "key", cell(pair.get(0), depth, ancestors),
                        "value", cell(pair.get(1), depth, ancestors)));
                }
            } finally { ancestors.remove(mapped.object.uniqueID()); }
            return save(MAP, captured);
        }

        private View indexed(ObjectReference object, LocalValueInspection.IndexedValue value, int depth, Set<Long> ancestors) {
            if (!take(value.length)) return null;
            ancestors.add(object.uniqueID());
            var captured = new ArrayList<Map<String,Object>>();
            try {
                for (Value entry : value.values(0, value.length)) {
                    captured.add(Map.of("index", captured.size(), "value", cell(entry, depth, ancestors)));
                }
            } finally { ancestors.remove(object.uniqueID()); }
            return save(ARRAY.equals(value.kind) ? ARRAY : LIST, captured);
        }

        private View save(String kind, List<Map<String,Object>> rows) {
            var view = new View(kind, rows);
            views.put(view.id, view);
            return view;
        }

        private Map<String,Object> cell(Value value, int depth, Set<Long> ancestors) {
            deadline();
            if (value == null) return leaf("null", "null");
            String type = value.type().name();
            if (type.length() > 256 || type.codePoints().anyMatch(c -> c < 32)) return leaf("object", "<opaque>");
            if (value instanceof PrimitiveValue) return leaf(type, value.toString());
            if (!(value instanceof ObjectReference)) return leaf(type, "<opaque>");
            var object = (ObjectReference) value;
            var actual = object.referenceType();
            if (value instanceof StringReference && bootstrap(actual, KotlinFieldValues.STRING)) {
                var string = (StringReference) value;
                return leaf(type, LocalValueInspection.storageUnits(string) <= MAX_STRING ?
                    KotlinFieldValues.displayText(string) : "<String exceeds 256 UTF-16 units>");
            }
            String primitive = wrapperPrimitive(actual.signature());
            if (primitive != null && bootstrap(actual, actual.signature())) {
                Field storage = field(actual, "value", primitive);
                Value boxed = storage == null || !storage.isFinal() ? null : object.getValue(storage);
                if (boxed instanceof PrimitiveValue) return leaf(type, boxed.toString());
            }
            if (ancestors.contains(object.uniqueID())) return leaf(type, "<cycle>");
            if (depth < MAX_DEPTH) {
                Ordered mapped = ordered(value);
                View child;
                if (mapped != null) child = map(mapped, depth + 1, ancestors);
                else {
                    var indexed = LocalValueInspection.indexed(value);
                    child = indexed == null ? null : indexed(object, indexed, depth + 1, ancestors);
                }
                if (child != null) {
                    return Map.of("type", type, "display", child.rows.size() + " entries", "child", child.id);
                }
            }
            return leaf(type, "<opaque>");
        }
    }

    private static final class Ordered {
        final ObjectReference object, head, tail;
        final int size, modCount;
        Ordered(ObjectReference object, int size, int modCount, ObjectReference head, ObjectReference tail) {
            this.object = object; this.size = size; this.modCount = modCount; this.head = head; this.tail = tail;
        }
    }

    private static final class View {
        final String id = UUID.randomUUID().toString(), kind;
        final List<Map<String,Object>> rows;
        View(String kind, List<Map<String,Object>> rows) { this.kind = kind; this.rows = List.copyOf(rows); }
    }

    private static final class Snapshot {
        final String id = UUID.randomUUID().toString(), root;
        final long created = System.nanoTime(), owner;
        final StackFrameReference reference;
        final StackFrame frame;
        final LocalVariable local;
        final int frameId, size, modCount;
        final Map<String,View> views;
        Snapshot(StackFrameReference reference, StackFrame frame, int frameId, LocalVariable local, Ordered map,
                 String root, Map<String,View> views) {
            this.reference = reference; this.frame = frame; this.frameId = frameId; this.local = local;
            this.owner = map.object.uniqueID(); this.size = map.size; this.modCount = map.modCount;
            this.root = root; this.views = Map.copyOf(views);
        }
        Map<String,Object> page(String id, int start, int count) {
            View view = id == null ? null : views.get(id);
            if (view == null || start > view.rows.size()) throw stale();
            int end = Math.min(view.rows.size(), start + count);
            return Map.of("kind", view.kind, "snapshotId", this.id, "viewId", view.id, "length", view.rows.size(),
                "start", start, "rows", view.rows.subList(start, end));
        }
    }

    private static IllegalArgumentException stale() { return denied("Inspect the current Kotlin collection snapshot again."); }
    private static IllegalArgumentException denied(String message) { return new IllegalArgumentException(message); }
}
