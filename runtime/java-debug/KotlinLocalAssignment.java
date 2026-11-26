package com.microsoft.java.debug.core.adapter;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.microsoft.java.debug.core.adapter.variables.StackFrameReference;
import com.microsoft.java.debug.core.protocol.Messages;
import com.sun.jdi.LocalVariable;
import com.sun.jdi.StackFrame;
import com.sun.jdi.VirtualMachine;
import java.util.ArrayList;
import java.util.Map;
import java.util.UUID;
import java.util.WeakHashMap;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

/** Explicit, one-use JDI writes to a reviewed primitive Kotlin local. */
final class KotlinLocalAssignment {
    private static final String REQUEST = "rocketbrain/setKotlinLocal";
    private static final Map<IDebugAdapterContext, Review> reviews = new WeakHashMap<>();

    private KotlinLocalAssignment() { }

    static CompletableFuture<Messages.Response> dispatch(Messages.Request request, Messages.Response response,
                                                           IDebugAdapterContext context) {
        if (!REQUEST.equals(request.command)) return null;
        try {
            response.body = handle(request.arguments,context);
            return CompletableFuture.completedFuture(response);
        } catch (IllegalArgumentException denied) {
            return AdapterUtils.createAsyncErrorResponse(response,ErrorCode.EVALUATE_FAILURE,denied.getMessage());
        } catch (Exception unavailable) {
            return AdapterUtils.createAsyncErrorResponse(response,ErrorCode.EVALUATE_FAILURE,
                "Keep the reviewed Kotlin frame suspended while editing its local value.");
        }
    }

    private static synchronized Map<String,Object> handle(JsonObject args, IDebugAdapterContext context) throws Exception {
        var action = text(args,"action");
        if ("cancel".equals(action)) {
            var review = reviews.get(context);
            if (review != null && review.id.equals(text(args,"reviewId"))) reviews.remove(context);
            return Map.of("state","cancelled");
        }
        if (context.isVmTerminated() || context.getLaunchMode() != LaunchMode.DEBUG || args == null) throw stale();
        int id = frameId(args);
        Object entry = context.getRecyclableIdPool().getObjectById(id);
        if (!(entry instanceof StackFrameReference)) throw stale();
        var reference = (StackFrameReference) entry;
        if (!reference.getThread().isSuspended()) throw stale();
        StackFrame frame = context.getStackFrameManager().getStackFrame(reference);
        if (frame == null || !isKotlinSource(frame.location().sourceName())) throw stale();

        if ("list".equals(action)) {
            var rows = new ArrayList<Map<String,Object>>();
            for (LocalVariable variable : frame.visibleVariables()) {
                String type = primitiveType(variable), name = variable.name();
                if (type != null && isName(name)) rows.add(Map.of("name",name,"type",type));
                if (rows.size() == 128) break;
            }
            return Map.of("locals",rows);
        }
        if ("prepare".equals(action)) {
            reviews.remove(context);
            String name = text(args,"name"), literal = text(args,"literal");
            if (!isName(name) || literal == null || literal.length() > 24) throw invalid("Choose a visible Kotlin primitive and a matching literal.");
            LocalVariable variable = frame.visibleVariableByName(name);
            String type = primitiveType(variable);
            if (type == null) throw invalid("Choose a visible Kotlin Int, Long or Boolean local.");
            var value = scalar(type,literal);
            var original = frame.getValue(variable);
            if (original == null) throw stale();
            var review = new Review(UUID.randomUUID().toString(),id,reference,frame,variable,original,value,System.nanoTime());
            reviews.put(context,review);
            return Map.of("reviewId",review.id,"name",name,"type",type,"before",original.toString(),"after",value.toString());
        }
        if ("apply".equals(action)) {
            var review = reviews.get(context);
            if (review == null || !review.id.equals(text(args,"reviewId"))) throw stale();
            reviews.remove(context);
            if (review.frameId != id || review.reference != reference ||
                !review.frame.equals(frame) || System.nanoTime()-review.prepared > TimeUnit.SECONDS.toNanos(30)) throw stale();
            var current = frame.visibleVariableByName(review.variable.name());
            if (!review.variable.equals(current) || !review.original.equals(frame.getValue(current))) {
                throw invalid("The Kotlin local changed. Review its current value again.");
            }
            frame.setValue(current,mirror(frame.virtualMachine(),review.replacement));
            return Map.of("state","applied","name",current.name(),"value",frame.getValue(current).toString());
        }
        throw invalid("Review a Kotlin local before editing it.");
    }

    private static boolean isKotlinSource(String file) { return file.endsWith(".kt") || file.endsWith(".kts"); }
    private static boolean isName(String name) { return name != null && name.matches("[A-Za-z_][A-Za-z0-9_]{0,127}"); }

    private static String primitiveType(LocalVariable variable) {
        if (variable == null) return null;
        switch (variable.signature()) {
            case "I": return "Int";
            case "J": return "Long";
            case "Z": return "Boolean";
            default: return null;
        }
    }

    private static Object scalar(String type, String literal) {
        try {
            if ("Int".equals(type) && literal.matches("-?(0|[1-9][0-9]*)")) return Integer.valueOf(literal);
            if ("Long".equals(type) && literal.matches("-?(0|[1-9][0-9]*)L")) return Long.valueOf(literal.substring(0,literal.length()-1));
            if ("Boolean".equals(type) && ("true".equals(literal) || "false".equals(literal))) return Boolean.valueOf(literal);
        } catch (NumberFormatException outOfRange) { throw invalid("The literal is outside the Kotlin local type's range."); }
        throw invalid("Enter a Kotlin " + type + " literal. Use an L suffix for Long.");
    }

    private static com.sun.jdi.Value mirror(VirtualMachine vm, Object value) {
        if (value instanceof Integer) return vm.mirrorOf((int) value);
        if (value instanceof Long) return vm.mirrorOf((long) value);
        return vm.mirrorOf((boolean) value);
    }

    private static String text(JsonObject args, String key) {
        JsonElement node = args == null ? null : args.get(key);
        return node != null && node.isJsonPrimitive() && node.getAsJsonPrimitive().isString() ? node.getAsString() : null;
    }

    private static int frameId(JsonObject args) {
        JsonElement node = args.get("frameId");
        if (node == null || !node.isJsonPrimitive() || !node.getAsJsonPrimitive().isNumber()) throw stale();
        try {
            int value = node.getAsBigDecimal().intValueExact();
            if (value > 0) return value;
        } catch (ArithmeticException ignored) { /* Fractional or oversized frame ID. */ }
        throw stale();
    }

    private static IllegalArgumentException stale() { return invalid("Keep the same Kotlin frame suspended and review its local value again."); }
    private static IllegalArgumentException invalid(String detail) { return new IllegalArgumentException(detail); }

    private static final class Review {
        final String id;
        final int frameId;
        final StackFrameReference reference;
        final StackFrame frame;
        final LocalVariable variable;
        final com.sun.jdi.Value original;
        final Object replacement;
        final long prepared;

        Review(String id,int frameId,StackFrameReference reference,StackFrame frame,LocalVariable variable,
               com.sun.jdi.Value original,Object replacement,long prepared) {
            this.id = id;
            this.frameId = frameId;
            this.reference = reference;
            this.frame = frame;
            this.variable = variable;
            this.original = original;
            this.replacement = replacement;
            this.prepared = prepared;
        }
    }
}
