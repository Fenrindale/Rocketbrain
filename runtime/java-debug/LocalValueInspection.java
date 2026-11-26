package com.microsoft.java.debug.core.adapter;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.microsoft.java.debug.core.adapter.variables.StackFrameReference;
import com.microsoft.java.debug.core.protocol.Messages;
import com.sun.jdi.ArrayReference;
import com.sun.jdi.IntegerValue;
import com.sun.jdi.LocalVariable;
import com.sun.jdi.ObjectReference;
import com.sun.jdi.PrimitiveValue;
import com.sun.jdi.StackFrame;
import com.sun.jdi.StringReference;
import com.sun.jdi.Value;

/** Reads selected JDI values without invoking code in the debuggee. */
final class LocalValueInspection {
    private static final int MAX_LOCALS = 128;
    private static final int MAX_PAGE = 100;
    private static final int MAX_STRING = 256 * 1024;
    private static final int STRING_CELL_LIMIT = 256;

    private LocalValueInspection() { }

    static CompletableFuture<Messages.Response> read(Messages.Request request, Messages.Response response, IDebugAdapterContext context) {
        try {
            if (context.isVmTerminated() || context.getLaunchMode() != LaunchMode.DEBUG || request.arguments == null) {
                return error(response, "Pause a Java debuggee before reading local values.");
            }
            JsonObject args = request.arguments;
            Integer frameId = integer(args, "frameId");
            Object found = frameId == null || frameId <= 0 ? null : context.getRecyclableIdPool().getObjectById(frameId);
            if (!(found instanceof StackFrameReference)) return error(response, "The reviewed Java stack frame is unavailable.");
            StackFrameReference frameRef = (StackFrameReference) found;
            if (!frameRef.getThread().isSuspended()) return error(response, "The Java thread resumed before its values could be read.");
            StackFrame frame = context.getStackFrameManager().getStackFrame(frameRef);
            if (frame == null) return error(response, "The reviewed Java stack frame is unavailable.");
            String action = text(args, "action");
            if ("list".equals(action)) response.body = list(frame);
            else {
                String name = text(args, "name");
                LocalVariable variable = name == null || name.isEmpty() || name.length() > 256 ? null : frame.visibleVariableByName(name);
                if (variable == null) return error(response, "Choose a visible local Java value from the reviewed frame.");
                Value value = frame.getValue(variable);
                if ("string".equals(action) && value instanceof StringReference) {
                    if (storageUnits((StringReference) value) > MAX_STRING) return error(response, "The Java string exceeds the complete-value limit of 256 Ki UTF-16 units.");
                    String contents = ((StringReference) value).value();
                    if (contents.length() > MAX_STRING) return error(response, "The Java string grew beyond the complete-value limit.");
                    response.body = Map.of("kind", "string", "length", contents.length(), "text", contents);
                } else if ("page".equals(action)) {
                    IndexedValue collection = indexed(value);
                    Integer start = integer(args, "start");
                    Integer count = integer(args, "count");
                    if (collection == null || start == null || count == null || start < 0 || start > collection.length || count < 1 || count > MAX_PAGE) {
                        return error(response, "Java value paging requires a supported array/list and a valid range of up to 100 rows.");
                    }
                    response.body = page(collection, start, count);
                } else return error(response, "The reviewed Java local value changed or is unsupported.");
            }
            return CompletableFuture.completedFuture(response);
        } catch (Exception staleFrame) {
            return error(response, "Java locals with debug metadata must stay suspended and readable during inspection.");
        }
    }

    private static Map<String, Object> list(StackFrame frame) throws Exception {
        List<LocalVariable> all = frame.visibleVariables();
        List<LocalVariable> visible = all.subList(0, Math.min(MAX_LOCALS, all.size()));
        Map<LocalVariable, Value> values = frame.getValues(visible);
        List<Map<String, Object>> entries = new java.util.ArrayList<>();
        for (LocalVariable variable : visible) {
            Value value = values.get(variable);
            if (variable.name().length() > 256) continue;
            if (value instanceof StringReference) {
                int length = storageUnits((StringReference) value);
                entries.add(Map.of("name", variable.name(), "kind", "string", "length", length, "complete", length <= MAX_STRING));
            } else {
                IndexedValue collection = indexed(value);
                if (collection != null) entries.add(Map.of("name", variable.name(), "kind", collection.kind, "length", collection.length));
            }
        }
        return Map.of("values", entries, "limited", all.size() > visible.size());
    }

    private static Map<String, Object> page(IndexedValue collection, int start, int count) {
        List<Map<String, Object>> rows = new java.util.ArrayList<>();
        int length = Math.min(count, collection.length - start);
        if (length > 0) for (Value value : collection.array.getValues(start, length)) {
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("index", start + rows.size());
            item.put("type", value == null ? "null" : value.type().name());
            if (value == null || value instanceof PrimitiveValue) item.put("display", String.valueOf(value));
            else if (value instanceof StringReference && storageUnits((StringReference) value) <= STRING_CELL_LIMIT) {
                item.put("display", ((StringReference) value).value());
            }
            rows.add(item);
        }
        return Map.of("kind", collection.kind, "length", collection.length, "start", start, "rows", rows);
    }

    static int storageUnits(StringReference string) {
        Value backing = field(string, "value", "[B");
        if (backing instanceof ArrayReference) {
            Value coder = field(string, "coder", "B");
            if (coder instanceof com.sun.jdi.ByteValue) {
                int encoding = ((com.sun.jdi.ByteValue) coder).intValue();
                if (encoding == 0 || encoding == 1) return ((ArrayReference) backing).length() >> encoding;
            }
        }
        backing = field(string, "value", "[C");
        return backing instanceof ArrayReference ? ((ArrayReference) backing).length() : Integer.MAX_VALUE;
    }

    private static IndexedValue indexed(Value value) {
        if (value instanceof ArrayReference) {
            ArrayReference array = (ArrayReference) value;
            return new IndexedValue("array", array, array.length());
        }
        if (!(value instanceof ObjectReference)) return null;
        ObjectReference object = (ObjectReference) value;
        if (!"java.util.ArrayList".equals(object.referenceType().name()) || object.referenceType().classLoader() != null) return null;
        Value size = field(object, "size", "I");
        Value backing = field(object, "elementData", "[Ljava/lang/Object;");
        if (!(size instanceof IntegerValue) || !(backing instanceof ArrayReference)) return null;
        int total = ((IntegerValue) size).intValue();
        ArrayReference array = (ArrayReference) backing;
        return total >= 0 && total <= array.length() ? new IndexedValue("arrayList", array, total) : null;
    }

    private static Value field(ObjectReference object, String name, String signature) {
        com.sun.jdi.Field field = object.referenceType().fieldByName(name);
        return field != null && !field.isStatic() && signature.equals(field.signature()) ? object.getValue(field) : null;
    }

    private static CompletableFuture<Messages.Response> error(Messages.Response response, String message) {
        return AdapterUtils.createAsyncErrorResponse(response, ErrorCode.GET_VARIABLE_FAILURE, message);
    }

    private static String text(JsonObject args, String key) {
        JsonElement node = args.get(key);
        return node != null && node.isJsonPrimitive() && node.getAsJsonPrimitive().isString() ? node.getAsString() : null;
    }

    private static Integer integer(JsonObject args, String key) {
        JsonElement node = args.get(key);
        return node != null && node.isJsonPrimitive() && node.getAsJsonPrimitive().isNumber() ? node.getAsBigDecimal().intValueExact() : null;
    }

    private static final class IndexedValue {
        final String kind;
        final ArrayReference array;
        final int length;

        IndexedValue(String kind, ArrayReference array, int length) {
            this.kind = kind;
            this.array = array;
            this.length = length;
        }
    }
}
