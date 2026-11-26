package com.microsoft.java.debug.core.adapter;

import java.util.Base64;
import java.util.Collections;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.WeakHashMap;

import com.google.gson.JsonObject;
import com.microsoft.java.debug.core.adapter.variables.StackFrameReference;
import com.sun.jdi.ArrayReference;
import com.sun.jdi.ByteValue;
import com.sun.jdi.ClassType;
import com.sun.jdi.Field;
import com.sun.jdi.IntegerValue;
import com.sun.jdi.LocalVariable;
import com.sun.jdi.ReferenceType;
import com.sun.jdi.StackFrame;
import com.sun.jdi.StringReference;
import com.sun.jdi.Value;

/** Reads exact UTF-16 code unit slices of observed OpenJDK String storage through JDI. */
final class JvmStringPages {
    private static final int PAGE_UNITS = 8192;
    private static final Map<IDebugAdapterContext, Boolean> LAUNCHES = Collections.synchronizedMap(new WeakHashMap<>());
    private static final Map<IDebugAdapterContext, Inspection> INSPECTIONS = Collections.synchronizedMap(new WeakHashMap<>());
    private static final Set<String> INVALIDATING = Set.of("attach", "launch", "continue", "next", "stepIn", "stepOut",
        "stepBack", "reverseContinue", "goto", "restartFrame", "restart", "disconnect", "terminate",
        "redefineClasses", "setVariable", "setExpression", "evaluate");

    private JvmStringPages() { }

    static void observe(IDebugAdapterContext context, String command, JsonObject args) {
        if (command == null) return;
        boolean write = ("rocketbrain/setKotlinLocal".equals(command) || "rocketbrain/kotlinObjectFields".equals(command))
            && "apply".equals(KotlinLocalAssignment.text(args, "action"));
        if (!write && !INVALIDATING.contains(command)) return;
        synchronized (context) {
            INSPECTIONS.remove(context);
            switch (command) {
                case "launch": LAUNCHES.put(context, true); break;
                case "attach":
                case "disconnect":
                case "terminate": LAUNCHES.remove(context); break;
                default: break;
            }
        }
    }

    private static boolean permitted(IDebugAdapterContext context) {
        return LAUNCHES.containsKey(context) || KotlinObjectFields.verifiedLocalAttach(context);
    }

    static boolean available(IDebugAdapterContext context, StringReference string) {
        if (!permitted(context)) return false;
        try { return storage(string) != null; }
        catch (RuntimeException layoutNotReadable) { return false; }
    }

    static Map<String, Object> read(IDebugAdapterContext context, StackFrameReference reference, StackFrame frame,
                                    int frameId, String action, JsonObject args, int completeLimit) throws Exception {
        synchronized (context) {
            if (!permitted(context)) throw denied("Inspect long Strings in a local Java launch or verified local attach.");
            Integer start, count;
            try {
                start = LocalValueInspection.integer(args, "start");
                count = LocalValueInspection.integer(args, "count");
            } catch (ArithmeticException outOfRange) {
                throw denied("Choose an exact non-negative String start index and an integer page size.");
            }
            if (start == null || start < 0 || count == null || count < 1 || count > PAGE_UNITS) {
                throw denied("Choose a valid String range of at most 8192 UTF-16 code units per page.");
            }
            var name = KotlinLocalAssignment.text(args, "name");
            LocalVariable local = name == null || name.isEmpty() || name.length() > 256 ? null : frame.visibleVariableByName(name);
            if (local == null || !reference.getThread().isSuspended() || frame.location().method().isObsolete()) throw stale();
            var value = frame.getValue(local);
            if (!(value instanceof StringReference)) throw stale();
            var string = (StringReference) value;
            Storage backing = storage(string);
            if (backing == null || backing.length <= completeLimit) {
                throw denied("Choose a long String with observed OpenJDK storage to read in pages.");
            }
            if (start > backing.length) throw denied("The String page starts outside the reviewed value.");
            boolean opened = "stringOpen".equals(action);
            Inspection review = opened ? new Inspection(UUID.randomUUID().toString(), frameId, reference, frame, local,
                string.uniqueID(), backing.bytes.uniqueID(), backing.length, backing.stride, backing.firstByteHigh)
                : INSPECTIONS.get(context);
            if (review == null || !opened && !review.id.equals(KotlinLocalAssignment.text(args, "pageId")) ||
                !review.matches(frameId, reference, frame, local, string, backing)) throw stale();
            int units = Math.min(count, backing.length - start);
            byte[] unicode = backing.littleEndianPage(start, units);
            if (!reference.getThread().isSuspended() || context.getRecyclableIdPool().getObjectById(frameId) != reference ||
                !frame.equals(context.getStackFrameManager().getStackFrame(reference))) throw stale();
            Value current = frame.getValue(local);
            if (!(current instanceof StringReference) || !review.matches(frameId, reference, frame, local,
                (StringReference) current, storage((StringReference) current))) throw stale();
            if (opened) INSPECTIONS.put(context, review);
            return Map.of("kind", "stringPage", "pageId", review.id, "length", backing.length, "start", start,
                "units", units, "encoding", "utf16le", "base64", Base64.getEncoder().encodeToString(unicode));
        }
    }

    private static Storage storage(StringReference string) {
        ReferenceType type = string.referenceType();
        if (!(type instanceof ClassType) || !bootstrap(type, "Ljava/lang/String;") || !type.isFinal()) return null;
        Field value = field(type, "value", "[B", false), coder = field(type, "coder", "B", false);
        if (value == null || coder == null) return null;
        var values = string.getValues(java.util.List.of(value, coder));
        if (!(values.get(value) instanceof ArrayReference) || !(values.get(coder) instanceof ByteValue)) return null;
        var buffer = (ArrayReference) values.get(value);
        if (!"[B".equals(buffer.referenceType().signature())) return null;
        int encoding = ((ByteValue) values.get(coder)).intValue();
        if (encoding == 0) return new Storage(buffer, buffer.length(), 1, false);
        if (encoding != 1 || (buffer.length() & 1) != 0) return null;
        Boolean firstByteHigh = utf16Order(type);
        return firstByteHigh == null ? null : new Storage(buffer, buffer.length() / 2, 2, firstByteHigh);
    }

    private static Boolean utf16Order(ReferenceType owner) {
        ReferenceType type = null;
        for (ReferenceType candidate : owner.virtualMachine().classesByName("java.lang.StringUTF16")) {
            if (!candidate.isPrepared() || !bootstrap(candidate, "Ljava/lang/StringUTF16;")) continue;
            if (type != null) return null;
            type = candidate;
        }
        if (type == null) return null;
        Field hi = field(type, "HI_BYTE_SHIFT", "I", true), lo = field(type, "LO_BYTE_SHIFT", "I", true);
        if (hi == null || lo == null) return null;
        var values = type.getValues(java.util.List.of(hi, lo));
        if (!(values.get(hi) instanceof IntegerValue) || !(values.get(lo) instanceof IntegerValue)) return null;
        int first = ((IntegerValue) values.get(hi)).value(), second = ((IntegerValue) values.get(lo)).value();
        if (first == 8 && second == 0) return true;
        if (first == 0 && second == 8) return false;
        return null;
    }

    private static boolean bootstrap(ReferenceType type, String signature) {
        if (type.classLoader() != null || !signature.equals(type.signature())) return false;
        if (!type.virtualMachine().canGetModuleInfo()) return true;
        var module = type.module();
        return module != null && "java.base".equals(module.name());
    }

    private static Field field(ReferenceType type, String name, String signature, boolean isStatic) {
        Field field = type.fieldByName(name);
        return field != null && field.isStatic() == isStatic && field.isFinal() && !field.isSynthetic() &&
            type.equals(field.declaringType()) && signature.equals(field.signature()) ? field : null;
    }

    private static final class Storage {
        final ArrayReference bytes;
        final int length, stride;
        final boolean firstByteHigh;

        Storage(ArrayReference bytes, int length, int stride, boolean firstByteHigh) {
            this.bytes = bytes;
            this.length = length;
            this.stride = stride;
            this.firstByteHigh = firstByteHigh;
        }

        byte[] littleEndianPage(int start, int units) {
            byte[] result = new byte[units * 2];
            if (units == 0) return result;
            var observed = bytes.getValues(start * stride, units * stride);
            if (observed.size() != units * stride) throw stale();
            for (int i = 0; i < units; i++) {
                int index = i * stride;
                byte first = ((ByteValue) observed.get(index)).byteValue();
                byte second = stride == 1 ? 0 : ((ByteValue) observed.get(index + 1)).byteValue();
                result[i * 2] = firstByteHigh ? second : first;
                result[i * 2 + 1] = firstByteHigh ? first : second;
            }
            return result;
        }
    }

    private static final class Inspection {
        final String id;
        final int frameId;
        final StackFrameReference reference;
        final StackFrame frame;
        final LocalVariable local;
        final long object, backing;
        final int length, stride;
        final boolean firstByteHigh;

        Inspection(String id, int frameId, StackFrameReference reference, StackFrame frame, LocalVariable local,
                   long object, long backing, int length, int stride, boolean firstByteHigh) {
            this.id = id;
            this.frameId = frameId;
            this.reference = reference;
            this.frame = frame;
            this.local = local;
            this.object = object;
            this.backing = backing;
            this.length = length;
            this.stride = stride;
            this.firstByteHigh = firstByteHigh;
        }

        boolean matches(int id, StackFrameReference ref, StackFrame current, LocalVariable variable, StringReference value, Storage storage) {
            return storage != null && id == frameId && ref == reference && frame.equals(current) && local.equals(variable) &&
                object == value.uniqueID() && backing == storage.bytes.uniqueID() && length == storage.length &&
                stride == storage.stride && firstByteHigh == storage.firstByteHigh;
        }
    }

    private static IllegalArgumentException stale() { return denied("Reopen the long String in the current suspended Java frame."); }
    private static IllegalArgumentException denied(String message) { return new IllegalArgumentException(message); }
}
