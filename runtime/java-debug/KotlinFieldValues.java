package com.microsoft.java.debug.core.adapter;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;
import com.sun.jdi.ArrayReference;
import com.sun.jdi.ByteValue;
import com.sun.jdi.CharValue;
import com.sun.jdi.ClassNotLoadedException;
import com.sun.jdi.ClassType;
import com.sun.jdi.Field;
import com.sun.jdi.IntegerValue;
import com.sun.jdi.Method;
import com.sun.jdi.ObjectReference;
import com.sun.jdi.ReferenceType;
import com.sun.jdi.StringReference;
import com.sun.jdi.ThreadReference;
import com.sun.jdi.Value;
import com.sun.jdi.request.EventRequest;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;

/** Bounded direct JDI values for the extended local Kotlin field inspector. */
final class KotlinFieldValues {
    static final String LOCAL_MARKER = "rocketbrainLocalKotlinFieldValues";
    static final String STRING = "Ljava/lang/String;";
    static final String UNAVAILABLE_TEXT = "<String preview unavailable>";
    static final int MAX_TEXT = 2048;
    static final int PAGE_SIZE = 32;
    private static final Map<String,String> ARRAY_ELEMENTS = Map.of("[I", "Int", "[J", "Long", "[Z", "Boolean");
    private static final Map<String,String> BOX_PRIMITIVES = Map.of(
        "Ljava/lang/Integer;", "I", "Ljava/lang/Long;", "J", "Ljava/lang/Boolean;", "Z");

    private KotlinFieldValues() { }

    static String elementType(String signature) { return ARRAY_ELEMENTS.get(signature); }

    private static boolean bootstrap(ReferenceType type, String signature) {
        if (type == null || type.classLoader() != null || !type.isPrepared() || !type.isInitialized() ||
                !signature.equals(type.signature())) return false;
        // Eclipse JDI does not report module mirrors. The bootstrap loader and full constructor
        // chain are required with either JDI implementation.
        if (!type.virtualMachine().canGetModuleInfo()) return true;
        var module = type.module();
        return module != null && "java.base".equals(module.name());
    }

    static Boxing boxing(Field field, ThreadReference thread, int depth) {
        String scalar = BOX_PRIMITIVES.get(field.signature());
        if (scalar == null || depth != 0 || thread.suspendCount() != 1 ||
                !bootstrap(thread.referenceType(), "Ljava/lang/Thread;")) return null;
        ReferenceType actual;
        try { actual = (ReferenceType) field.type(); }
        catch (ClassNotLoadedException unavailable) { return null; }
        if (!(actual instanceof ClassType) || !actual.isFinal() || !bootstrap(actual, field.signature())) return null;
        ClassType owner = (ClassType) actual;
        Field storage = owner.fieldByName("value");
        if (!layoutField(owner, storage, scalar, false) || !storage.isPrivate()) return null;
        ClassType parent = owner.superclass();
        ClassType object = "Z".equals(scalar) ? parent : parent == null ? null : parent.superclass();
        if (!bootstrap(object, "Ljava/lang/Object;") || object.superclass() != null ||
                !"Z".equals(scalar) && !bootstrap(parent, "Ljava/lang/Number;")) return null;
        Method constructor = KotlinFieldAccess.bootstrapConstructor(owner, parent, storage);
        Method root = KotlinFieldAccess.bootstrapConstructor(object, null, null);
        if (constructor == null || root == null) return null;
        Method number = parent.equals(object) ? null : KotlinFieldAccess.bootstrapConstructor(parent, object, null);
        if (!parent.equals(object) && number == null) return null;
        var chain = number == null ? List.of(constructor, root) : List.of(constructor, number, root);
        return transparentEvents(thread, storage, chain) ? new Boxing(owner, storage, chain) : null;
    }

    private static boolean suspends(EventRequest request) {
        return request.isEnabled() && request.suspendPolicy() != EventRequest.SUSPEND_NONE;
    }

    private static boolean transparentEvents(ThreadReference thread, Field storage, List<Method> chain) {
        var requests = thread.virtualMachine().eventRequestManager();
        return requests.methodEntryRequests().stream().noneMatch(KotlinFieldValues::suspends) &&
            requests.methodExitRequests().stream().noneMatch(KotlinFieldValues::suspends) &&
            requests.exceptionRequests().stream().noneMatch(KotlinFieldValues::suspends) &&
            requests.stepRequests().stream().noneMatch(r -> suspends(r) &&
                (r.thread().equals(thread) || r.suspendPolicy() == EventRequest.SUSPEND_ALL)) &&
            requests.breakpointRequests().stream().noneMatch(r -> suspends(r) &&
                (chain.contains(r.location().method()) || r.suspendPolicy() == EventRequest.SUSPEND_ALL)) &&
            requests.modificationWatchpointRequests().stream().noneMatch(r -> suspends(r) &&
                (storage.equals(r.field()) || r.suspendPolicy() == EventRequest.SUSPEND_ALL)) &&
            requests.accessWatchpointRequests().stream().noneMatch(r -> suspends(r) && r.suspendPolicy() == EventRequest.SUSPEND_ALL);
    }

    static final class Boxing {
        final ClassType owner;
        final Field storage;
        final List<Method> chain;

        Boxing(ClassType owner, Field storage, List<Method> chain) {
            this.owner = owner;
            this.storage = storage;
            this.chain = chain;
        }

        boolean matches(Boxing latest) {
            return latest != null && owner.equals(latest.owner) && storage.equals(latest.storage) && chain.equals(latest.chain);
        }

        ObjectReference construct(ThreadReference thread, Value value) throws Exception {
            return owner.newInstance(thread, chain.get(0), List.of(value), ClassType.INVOKE_SINGLE_THREADED);
        }
    }

    static boolean isString(Field field) { return STRING.equals(field.signature()); }

    static ArrayReference array(Field field, Value value) {
        if (!(value instanceof ArrayReference)) return null;
        ArrayReference reference = (ArrayReference) value;
        return field.signature().equals(reference.referenceType().signature()) ? reference : null;
    }

    static boolean reviewedLocalAttach(JsonObject args) {
        JsonElement value = args == null ? null : args.get(LOCAL_MARKER);
        return value != null && value.isJsonPrimitive() && value.getAsJsonPrimitive().isBoolean() &&
            value.getAsBoolean() && "127.0.0.1".equals(KotlinLocalAssignment.text(args, "hostName"));
    }

    static int index(JsonObject args, String name) {
        JsonElement node = args == null ? null : args.get(name);
        if (node != null && node.isJsonPrimitive() && node.getAsJsonPrimitive().isNumber()) {
            try {
                int value = node.getAsBigDecimal().intValueExact();
                if (value >= 0) return value;
            } catch (ArithmeticException ignored) { /* Reject fractional or oversized indices. */ }
        }
        throw new IllegalArgumentException("Choose an exact non-negative Kotlin array index.");
    }

    static String checkText(String value) {
        if (value == null || value.length() > MAX_TEXT ||
                value.codePoints().anyMatch(cp -> cp == 0 || (cp >= 0xd800 && cp <= 0xdfff))) {
            throw new IllegalArgumentException("Use valid Kotlin field text of at most 2048 UTF-16 units.");
        }
        return value;
    }

    static String quote(String value) { return new JsonPrimitive(value).toString(); }

    static String displayText(Value value) {
        if (value == null) return "null";
        if (!(value instanceof StringReference)) return UNAVAILABLE_TEXT;
        StringReference string = (StringReference) value;
        var type = string.referenceType();
        if (type.classLoader() != null || !STRING.equals(type.signature())) return UNAVAILABLE_TEXT;
        // Read exact bounded characters from verified storage. Some JDI
        // transports do not preserve supplementary characters in value().
        Field backing = type.fieldByName("value");
        if (backing == null || !backing.declaringType().equals(type) || !backing.isFinal() || backing.isStatic() ||
                !("[B".equals(backing.signature()) || "[C".equals(backing.signature()))) return UNAVAILABLE_TEXT;
        ArrayReference storage = array(backing, string.getValue(backing));
        if (storage == null) return UNAVAILABLE_TEXT;
        String result = "[C".equals(backing.signature()) ? characters(storage) : compactText(type, string, storage);
        return result == null || result.codePoints().anyMatch(cp -> cp >= 0xd800 && cp <= 0xdfff) ? UNAVAILABLE_TEXT : quote(result);
    }

    private static String characters(ArrayReference storage) {
        int length = storage.length();
        if (length > MAX_TEXT) return null;
        char[] chars = new char[length];
        List<Value> values = storage.getValues(0, length);
        for (int i = 0; i < length; i++) {
            if (!(values.get(i) instanceof CharValue)) return null;
            chars[i] = ((CharValue) values.get(i)).value();
        }
        return new String(chars);
    }

    private static String compactText(ReferenceType owner, StringReference string, ArrayReference storage) {
        Field coder = owner.fieldByName("coder");
        if (!layoutField(owner, coder, "B", false)) return null;
        Value observed = string.getValue(coder);
        if (!(observed instanceof ByteValue)) return null;
        int code = ((ByteValue) observed).value(), length = storage.length();
        if ((code != 0 && code != 1) || length > (MAX_TEXT << code) || code == 1 && (length & 1) != 0) return null;
        int high = code == 1 ? highShift(owner) : 0;
        if (high < 0) return null;
        byte[] bytes = new byte[length];
        List<Value> values = storage.getValues(0, length);
        for (int i = 0; i < length; i++) {
            if (!(values.get(i) instanceof ByteValue)) return null;
            bytes[i] = ((ByteValue) values.get(i)).value();
        }
        if (code == 0) return new String(bytes, StandardCharsets.ISO_8859_1);
        var charset = high == 8 ? StandardCharsets.UTF_16BE : StandardCharsets.UTF_16LE;
        try { return charset.newDecoder().decode(ByteBuffer.wrap(bytes)).toString(); }
        catch (CharacterCodingException invalid) { return null; }
    }

    private static int highShift(ReferenceType stringType) {
        List<ReferenceType> layouts = stringType.virtualMachine().classesByName("java.lang.StringUTF16");
        if (layouts.size() != 1) return -1;
        ReferenceType layout = layouts.get(0);
        if (layout.classLoader() != null || !layout.isInitialized() || !"Ljava/lang/StringUTF16;".equals(layout.signature())) return -1;
        Field high = layout.fieldByName("HI_BYTE_SHIFT"), low = layout.fieldByName("LO_BYTE_SHIFT");
        if (!layoutField(layout, high, "I", true) || !layoutField(layout, low, "I", true)) return -1;
        Value first = layout.getValue(high), second = layout.getValue(low);
        if (!(first instanceof IntegerValue) || !(second instanceof IntegerValue)) return -1;
        int a = ((IntegerValue) first).value(), b = ((IntegerValue) second).value();
        return (a == 8 && b == 0 || a == 0 && b == 8) ? a : -1;
    }

    private static boolean layoutField(ReferenceType owner, Field field, String signature, boolean staticField) {
        return field != null && owner.equals(field.declaringType()) && field.isFinal() && field.isStatic() == staticField &&
            signature.equals(field.signature());
    }
}
