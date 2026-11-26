package com.microsoft.java.debug.core.adapter;

import com.google.gson.JsonObject;
import com.microsoft.java.debug.core.adapter.variables.StackFrameReference;
import com.microsoft.java.debug.core.protocol.Messages;
import com.sun.jdi.ClassType;
import com.sun.jdi.Field;
import com.sun.jdi.LocalVariable;
import com.sun.jdi.ObjectReference;
import com.sun.jdi.PrimitiveValue;
import com.sun.jdi.StackFrame;
import com.sun.jdi.Value;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import java.util.WeakHashMap;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

/** Observe or review one exact Kotlin JVM instance field without calling debuggee code. */
final class KotlinObjectFields {
    private static final String REQUEST = "rocketbrain/kotlinObjectFields";
    private static final Set<String> INVALIDATING = Set.of("continue", "next", "stepIn", "stepOut", "restartFrame",
        "restart", "redefineClasses", "disconnect", "terminate", "reverseContinue", "stepBack");
    private static final Map<String, String> PRIMITIVES = Map.of("I", "Int", "J", "Long", "Z", "Boolean");
    private static final Map<String, String> BOXES = Map.of("Ljava/lang/Integer;", "I", "Ljava/lang/Long;", "J", "Ljava/lang/Boolean;", "Z");
    private static final Map<IDebugAdapterContext, Review> REVIEWS = Collections.synchronizedMap(new WeakHashMap<>());
    private static final int MAX_LOCALS = 128;
    private static final int MAX_CLASS_FIELDS = 256;

    private KotlinObjectFields() { }

    static CompletableFuture<Messages.Response> dispatch(Messages.Request request, Messages.Response response,
                                                         IDebugAdapterContext context) {
        if (request.command == null || (!REQUEST.equals(request.command) && !INVALIDATING.contains(request.command))) return null;
        synchronized (context) {
            if (!REQUEST.equals(request.command)) {
                REVIEWS.remove(context);
                return null;
            }
            try {
                response.body = handle(request.arguments, context);
                return CompletableFuture.completedFuture(response);
            } catch (IllegalArgumentException denied) {
                return AdapterUtils.createAsyncErrorResponse(response, ErrorCode.EVALUATE_FAILURE, denied.getMessage());
            } catch (Exception unavailable) {
                return AdapterUtils.createAsyncErrorResponse(response, ErrorCode.EVALUATE_FAILURE,
                    "The Kotlin object or its paused JVM field is no longer available. Inspect it again.");
            }
        }
    }

    private static Object handle(JsonObject args, IDebugAdapterContext context) throws Exception {
        String action = KotlinLocalAssignment.text(args, "action");
        if ("cancel".equals(action)) {
            Review review = REVIEWS.get(context);
            if (review != null && review.id.equals(KotlinLocalAssignment.text(args, "reviewId"))) REVIEWS.remove(context);
            return Map.of("state", "cancelled");
        }
        if ("apply".equals(action)) {
            Review review = REVIEWS.get(context);
            if (review == null || !review.id.equals(KotlinLocalAssignment.text(args, "reviewId"))) throw stale();
            REVIEWS.remove(context);
            return apply(context, args, review);
        }
        var frame = selectedFrame(context, args);
        if ("receivers".equals(action)) return Map.of("receivers", receivers(frame.frame));
        String receiverName = KotlinLocalAssignment.text(args, "receiver");
        Receiver receiver = receiver(frame.frame, visible(frame.frame, receiverName));
        if (receiver == null) throw invalid("Choose a visible Kotlin object local with its exact declared JVM class.");
        if ("fields".equals(action)) return Map.of("fields", fields(frame.frame, receiver));
        if (!"prepare".equals(action)) throw invalid("Review one Kotlin object field before editing it.");
        REVIEWS.remove(context);
        String name = KotlinLocalAssignment.text(args, "name");
        Field field = field(receiver, name);
        if (!writable(receiver, field)) throw invalid("Choose a writable Kotlin scalar field with direct storage.");
        String input = KotlinLocalAssignment.text(args, "input");
        if (input == null || input.length() > MAX_LOCALS) throw invalid("Choose a matching Kotlin scalar literal or boxed local.");
        Value original = receiver.object.getValue(field);
        var replacement = replacement(frame.frame, field, input);
        var review = new Review(UUID.randomUUID().toString(), frame, receiver, field, original, replacement, System.nanoTime());
        var summary = Map.of("reviewId", review.id, "receiver", receiverName, "owner", receiver.owner.name(),
            "name", name, "type", type(field), "before", display(field, original), "after", display(field, replacement.value));
        REVIEWS.put(context, review);
        return summary;
    }

    private static List<Map<String,Object>> receivers(StackFrame frame) throws Exception {
        var rows = new ArrayList<Map<String,Object>>();
        for (LocalVariable local : observedLocals(frame)) {
            Receiver receiver = receiver(frame, local);
            if (receiver != null && !supportedFields(receiver).isEmpty()) {
                rows.add(Map.of("name", local.name(), "owner", receiver.owner.name()));
            }
        }
        return rows;
    }

    private static List<Map<String,Object>> fields(StackFrame frame, Receiver receiver) throws Exception {
        List<Field> supported = supportedFields(receiver);
        var values = receiver.object.getValues(supported);
        var rows = new ArrayList<Map<String,Object>>();
        var access = supported.stream().anyMatch(field -> !field.isFinal() && !field.isPublic())
            ? KotlinFieldAccess.inspect(receiver.owner) : null;
        var locals = observedLocals(frame);
        for (Field field : supported) {
            boolean boxed = BOXES.containsKey(field.signature());
            boolean canWrite = frame.virtualMachine().canBeModified() && KotlinFieldAccess.writable(field, access);
            var sources = new ArrayList<String>();
            if (boxed && canWrite) {
                for (LocalVariable local : locals) if (boxSource(frame, field, local) != null) sources.add(local.name());
            }
            rows.add(Map.of("name", field.name(), "type", type(field), "value", display(field, values.get(field)),
                "boxed", boxed, "writable", canWrite, "boxSources", sources));
        }
        return rows;
    }

    private static Map<String,Object> apply(IDebugAdapterContext context, JsonObject args, Review review) throws Exception {
        Frame selected = selectedFrame(context, args);
        checkFrame(review, selected);
        var vm = selected.frame.virtualMachine();
        if (!vm.canBeModified()) throw invalid("This Kotlin JVM does not allow field updates.");
        // A method breakpoint can suspend only one thread. Freeze other threads only for compare-and-write,
        // and balance precisely this suspension without changing the debugger's existing thread state.
        vm.suspend();
        try {
            Frame current = selectedFrame(context, args);
            checkFrame(review, current);
            if (current.reference.getThread().suspendCount() < 2) throw stale();
            Receiver receiver = receiver(current.frame, visible(current.frame, review.receiver.local.name()));
            if (receiver == null || !review.receiver.local.equals(receiver.local) ||
                !review.receiver.object.equals(receiver.object) || !review.receiver.owner.equals(receiver.owner)) throw stale();
            Field field = field(receiver, review.field.name());
            if (!review.field.equals(field) || !writable(receiver, field) ||
                !Objects.equals(review.original, receiver.object.getValue(field))) {
                throw invalid("The Kotlin object field changed. Inspect its current value again.");
            }
            if (review.replacement.source != null) {
                LocalVariable source = visible(current.frame, review.replacement.source.name());
                if (!review.replacement.source.equals(source) ||
                    !review.replacement.value.equals(boxSource(current.frame, field, source))) {
                    throw invalid("The boxed local changed. Review its current value again.");
                }
            }
            receiver.object.setValue(field, review.replacement.value);
            return Map.of("state", "applied", "receiver", receiver.local.name(),
                "name", field.name(), "value", display(field, receiver.object.getValue(field)));
        } finally {
            vm.resume();
        }
    }

    private static void checkFrame(Review review, Frame target) {
        if (review.frame.id != target.id || review.frame.reference != target.reference ||
            !review.frame.frame.equals(target.frame) || review.frame.frame.location().method().isObsolete() ||
            System.nanoTime() - review.prepared > TimeUnit.SECONDS.toNanos(30)) throw stale();
    }

    private static Frame selectedFrame(IDebugAdapterContext context, JsonObject args) throws Exception {
        if (args == null || context.isVmTerminated() || context.getLaunchMode() != LaunchMode.DEBUG) throw stale();
        int id = KotlinLocalAssignment.frameId(args);
        Object entry = context.getRecyclableIdPool().getObjectById(id);
        if (!(entry instanceof StackFrameReference)) throw stale();
        var reference = (StackFrameReference) entry;
        if (!reference.getThread().isSuspended()) throw stale();
        StackFrame frame = context.getStackFrameManager().getStackFrame(reference);
        if (frame == null || !kotlinSource(frame.location().sourceName()) || frame.location().method().isObsolete()) throw stale();
        return new Frame(id, reference, frame);
    }

    private static boolean kotlinSource(String name) { return name.endsWith(".kt") || name.endsWith(".kts"); }

    private static List<LocalVariable> observedLocals(StackFrame frame) throws Exception {
        List<LocalVariable> locals = frame.visibleVariables();
        if (locals.size() > MAX_LOCALS) throw invalid("This Kotlin frame has more than 128 visible JVM locals.");
        return locals.stream().filter(local -> KotlinLocalAssignment.isName(local.name())).collect(java.util.stream.Collectors.toList());
    }

    private static LocalVariable visible(StackFrame frame, String name) throws Exception {
        return KotlinLocalAssignment.isName(name) ? frame.visibleVariableByName(name) : null;
    }

    private static Receiver receiver(StackFrame frame, LocalVariable local) throws Exception {
        if (local == null || !local.signature().startsWith("L") || BOXES.containsKey(local.signature())) return null;
        Value value = frame.getValue(local);
        if (!(value instanceof ObjectReference)) return null;
        var object = (ObjectReference) value;
        if (!(object.referenceType() instanceof ClassType)) return null;
        var owner = (ClassType) object.referenceType();
        if (owner.classLoader() == null || owner.isEnum() || !owner.signature().equals(local.signature()) || owner.name().length() > 512) return null;
        try { return kotlinSource(owner.sourceName()) ? new Receiver(local, object, owner) : null; }
        catch (com.sun.jdi.AbsentInformationException unavailable) { return null; }
    }

    private static List<Field> supportedFields(Receiver receiver) {
        List<Field> all = receiver.owner.fields();
        if (all.size() > MAX_CLASS_FIELDS) throw invalid("This Kotlin class has more than 256 declared JVM fields.");
        var names = new java.util.HashSet<String>();
        var duplicates = new java.util.HashSet<String>();
        for (Field field : all) if (!names.add(field.name())) duplicates.add(field.name());
        return all.stream().filter(field -> !duplicates.contains(field.name()) && inspectable(field))
            .collect(java.util.stream.Collectors.toList());
    }

    private static boolean inspectable(Field field) {
        return !field.isStatic() && !field.isSynthetic() && KotlinLocalAssignment.isName(field.name()) && type(field) != null;
    }

    private static Field field(Receiver receiver, String name) {
        return supportedFields(receiver).stream().filter(field -> field.name().equals(name)).findFirst().orElse(null);
    }

    private static boolean writable(Receiver receiver, Field field) {
        return field != null && receiver.object.virtualMachine().canBeModified() && KotlinFieldAccess.writable(field,
            field.isFinal() || field.isPublic() ? null : KotlinFieldAccess.inspect(receiver.owner));
    }

    private static String type(Field field) {
        String signature = field.signature();
        String unboxed = BOXES.get(signature);
        return unboxed == null ? PRIMITIVES.get(signature) : PRIMITIVES.get(unboxed) + " (boxed)";
    }

    private static Value boxSource(StackFrame frame, Field field, LocalVariable variable) {
        if (variable == null || !field.signature().equals(variable.signature())) return null;
        Value value = frame.getValue(variable);
        return boxMatches(field, value) ? value : null;
    }

    private static boolean boxMatches(Field field, Value value) {
        if (!(value instanceof ObjectReference)) return false;
        var type = ((ObjectReference) value).referenceType();
        return type.classLoader() == null && field.signature().equals(type.signature());
    }

    private static Replacement replacement(StackFrame frame, Field field, String input) throws Exception {
        String primitive = PRIMITIVES.get(field.signature());
        if (primitive != null) {
            return new Replacement(KotlinLocalAssignment.mirror(frame.virtualMachine(), KotlinLocalAssignment.scalar(primitive, input)), null);
        }
        LocalVariable local = visible(frame, input);
        Value source = boxSource(frame, field, local);
        if (source == null) throw invalid("Choose a visible non-null local with the exact boxed Kotlin field type.");
        return new Replacement(source, local);
    }

    private static String display(Field field, Value value) {
        if (value == null) return "null";
        if (boxMatches(field, value)) {
            var object = (ObjectReference) value;
            Field slot = object.referenceType().fieldByName("value");
            if (slot == null || !slot.isFinal() || slot.isStatic() || !BOXES.get(field.signature()).equals(slot.signature())) {
                throw invalid("The JVM boxed field layout is unavailable.");
            }
            value = object.getValue(slot);
        }
        if (!(value instanceof PrimitiveValue)) throw invalid("The Kotlin field scalar layout is unavailable.");
        return value.toString();
    }

    private static IllegalArgumentException invalid(String message) { return new IllegalArgumentException(message); }
    private static IllegalArgumentException stale() { return invalid("Keep the same Kotlin frame suspended and review the object field again."); }

    private static final class Frame {
        final int id;
        final StackFrameReference reference;
        final StackFrame frame;
        Frame(int id, StackFrameReference reference, StackFrame frame) { this.id=id; this.reference=reference; this.frame=frame; }
    }

    private static final class Receiver {
        final LocalVariable local;
        final ObjectReference object;
        final ClassType owner;
        Receiver(LocalVariable local, ObjectReference object, ClassType owner) { this.local=local; this.object=object; this.owner=owner; }
    }

    private static final class Replacement {
        final Value value;
        final LocalVariable source;
        Replacement(Value value, LocalVariable source) { this.value=value; this.source=source; }
    }

    private static final class Review {
        final String id;
        final Frame frame;
        final Receiver receiver;
        final Field field;
        final Value original;
        final Replacement replacement;
        final long prepared;
        Review(String id, Frame frame, Receiver receiver, Field field, Value original, Replacement replacement, long prepared) {
            this.id=id; this.frame=frame; this.receiver=receiver; this.field=field;
            this.original=original; this.replacement=replacement; this.prepared=prepared;
        }
    }
}
