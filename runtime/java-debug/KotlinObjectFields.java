package com.microsoft.java.debug.core.adapter;

import com.google.gson.JsonObject;
import com.microsoft.java.debug.core.adapter.variables.StackFrameReference;
import com.microsoft.java.debug.core.protocol.Messages;
import com.sun.jdi.ArrayReference;
import com.sun.jdi.ClassType;
import com.sun.jdi.Field;
import com.sun.jdi.LocalVariable;
import com.sun.jdi.ObjectReference;
import com.sun.jdi.PrimitiveValue;
import com.sun.jdi.StackFrame;
import com.sun.jdi.StringReference;
import com.sun.jdi.Value;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.LinkedHashMap;
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
        "restart", "redefineClasses", "disconnect", "terminate", "reverseContinue", "stepBack", "goto",
        "setBreakpoints", "setFunctionBreakpoints", "setExceptionBreakpoints", "setDataBreakpoints", "setInstructionBreakpoints");
    private static final Map<String, String> PRIMITIVES = Map.of("I", "Int", "J", "Long", "Z", "Boolean");
    private static final Map<String, String> BOXES = Map.of("Ljava/lang/Integer;", "I", "Ljava/lang/Long;", "J", "Ljava/lang/Boolean;", "Z");
    private static final Map<IDebugAdapterContext, Review> REVIEWS = Collections.synchronizedMap(new WeakHashMap<>());
    private static final Map<IDebugAdapterContext, Page> PAGES = Collections.synchronizedMap(new WeakHashMap<>());
    private static final Map<IDebugAdapterContext, Boolean> REVIEWED_LOCAL_ATTACH = Collections.synchronizedMap(new WeakHashMap<>());
    private static final int MAX_LOCALS = 128;
    private static final int MAX_CLASS_FIELDS = 256;

    private KotlinObjectFields() { }

    static CompletableFuture<Messages.Response> dispatch(Messages.Request request, Messages.Response response,
                                                         IDebugAdapterContext context) {
        if ("attach".equals(request.command) || "launch".equals(request.command)) {
            REVIEWED_LOCAL_ATTACH.remove(context);
            if ("attach".equals(request.command) && KotlinFieldValues.reviewedLocalAttach(request.arguments)) {
                REVIEWED_LOCAL_ATTACH.put(context, true);
            }
            return null;
        }
        if (request.command == null || (!REQUEST.equals(request.command) && !INVALIDATING.contains(request.command))) return null;
        synchronized (context) {
            if (!REQUEST.equals(request.command)) {
                REVIEWS.remove(context);
                PAGES.remove(context);
                if ("disconnect".equals(request.command) || "terminate".equals(request.command)) REVIEWED_LOCAL_ATTACH.remove(context);
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
        boolean extended = extended(context, frame);
        if ("receivers".equals(action)) return Map.of("receivers", receivers(frame.frame, extended));
        String receiverName = KotlinLocalAssignment.text(args, "receiver");
        Receiver receiver = receiver(frame.frame, visible(frame.frame, receiverName));
        if (receiver == null) throw invalid("Choose a visible Kotlin object local with its exact declared JVM class.");
        if ("fields".equals(action)) return Map.of("fields", fields(frame, receiver, extended, REVIEWED_LOCAL_ATTACH.containsKey(context)));
        if ("page".equals(action)) {
            if (!extended) throw invalid("Inspect additional Kotlin field values in a verified local JVM session.");
            return page(context, args, frame, receiver);
        }
        boolean freshBox = "prepareLiteral".equals(action);
        if (!"prepare".equals(action) && !freshBox) throw invalid("Review one Kotlin object field before editing it.");
        REVIEWS.remove(context);
        String name = KotlinLocalAssignment.text(args, "name");
        String input = KotlinLocalAssignment.text(args, "input");
        if (args.has("pageId") || args.has("index")) {
            if (freshBox) throw invalid("Choose one writable boxed Kotlin field.");
            if (!extended) throw invalid("Edit Kotlin array elements in a verified local JVM session.");
            return prepareElement(context, args, frame, receiver, name, input);
        }
        Field field = field(receiver, name, extended);
        if (field != null && KotlinFieldValues.elementType(field.signature()) != null) {
            throw invalid("Choose a reviewed Kotlin array element instead of replacing the field.");
        }
        if (!writable(receiver, field)) throw invalid("Choose a writable Kotlin scalar field with direct storage.");
        Value original = receiver.object.getValue(field);
        if (freshBox) {
            if (!REVIEWED_LOCAL_ATTACH.containsKey(context) || input == null || input.length() > 24) throw boxUnavailable();
            var boxing = KotlinFieldValues.boxing(field, frame.reference.getThread(), frame.reference.getDepth());
            if (boxing == null) throw boxUnavailable();
            String scalar = PRIMITIVES.get(BOXES.get(field.signature()));
            var literal = KotlinLocalAssignment.scalar(scalar, input);
            var primitive = KotlinLocalAssignment.mirror(frame.frame.virtualMachine(), literal);
            return review(context, frame, receiver, field, original, new Replacement(primitive, null, null, boxing), null, -1,
                type(field), display(field, original), scalarDisplay(primitive));
        }
        if (KotlinFieldValues.isString(field)) {
            String before = KotlinFieldValues.displayText(original);
            if (KotlinFieldValues.UNAVAILABLE_TEXT.equals(before)) throw invalid("This Kotlin String has no bounded value to review.");
            String text = KotlinFieldValues.checkText(input);
            return review(context, frame, receiver, field, original, new Replacement(null, null, text), null, -1,
                "String", before, KotlinFieldValues.quote(text));
        }
        if (input == null || input.length() > MAX_LOCALS) throw invalid("Choose a matching Kotlin scalar literal or boxed local.");
        var replacement = replacement(frame.frame, field, input);
        return review(context, frame, receiver, field, original, replacement, null, -1,
            type(field), display(field, original), display(field, replacement.value));
    }

    private static boolean extended(IDebugAdapterContext context, Frame frame) {
        return REVIEWED_LOCAL_ATTACH.containsKey(context) || frame.frame.virtualMachine().process() != null;
    }

    private static List<Map<String,Object>> receivers(StackFrame frame, boolean extended) throws Exception {
        var rows = new ArrayList<Map<String,Object>>();
        for (LocalVariable local : observedLocals(frame)) {
            Receiver receiver = receiver(frame, local);
            if (receiver != null && !supportedFields(receiver, extended).isEmpty()) {
                rows.add(Map.of("name", local.name(), "owner", receiver.owner.name()));
            }
        }
        return rows;
    }

    private static List<Map<String,Object>> fields(Frame selected, Receiver receiver, boolean extended, boolean verifiedAttach) throws Exception {
        StackFrame frame = selected.frame;
        List<Field> supported = supportedFields(receiver, extended);
        var values = receiver.object.getValues(supported);
        var rows = new ArrayList<Map<String,Object>>();
        var access = supported.stream().anyMatch(field -> !field.isPublic() &&
            (!field.isFinal() || KotlinFieldValues.elementType(field.signature()) != null))
            ? KotlinFieldAccess.inspect(receiver.owner) : null;
        var locals = observedLocals(frame);
        for (Field field : supported) {
            Value value = values.get(field);
            String elementType = KotlinFieldValues.elementType(field.signature());
            if (elementType != null) {
                ArrayReference array = KotlinFieldValues.array(field, value);
                if (value != null && array == null) continue;
                int length = array == null ? 0 : array.length();
                rows.add(Map.of("name", field.name(), "type", elementType + "Array", "kind", "array",
                    "value", array == null ? "null" : "length " + length, "length", length, "elementType", elementType,
                    "boxed", false, "writable", array != null && canEditElements(receiver, field, access), "boxSources", List.of()));
                continue;
            }
            if (KotlinFieldValues.isString(field)) {
                String text = KotlinFieldValues.displayText(value);
                rows.add(Map.of("name", field.name(), "type", "String", "kind", "text", "value", text, "boxed", false,
                    "writable", frame.virtualMachine().canBeModified() && !KotlinFieldValues.UNAVAILABLE_TEXT.equals(text)
                        && KotlinFieldAccess.writable(field, access), "boxSources", List.of()));
                continue;
            }
            boolean boxed = BOXES.containsKey(field.signature());
            boolean canWrite = frame.virtualMachine().canBeModified() && KotlinFieldAccess.writable(field, access);
            var sources = new ArrayList<String>();
            if (boxed && canWrite) {
                for (LocalVariable local : locals) if (boxSource(frame, field, local) != null) sources.add(local.name());
            }
            var row = new LinkedHashMap<String,Object>(Map.of("name", field.name(), "type", type(field), "value", display(field, value),
                "boxed", boxed, "writable", canWrite, "boxSources", sources));
            if (boxed && canWrite && verifiedAttach &&
                KotlinFieldValues.boxing(field, selected.reference.getThread(), selected.reference.getDepth()) != null) {
                row.put("boxLiteral", true);
            }
            rows.add(row);
        }
        return rows;
    }

    private static Map<String,Object> page(IDebugAdapterContext context, JsonObject args, Frame frame, Receiver receiver) {
        String name = KotlinLocalAssignment.text(args, "name");
        Field field = field(receiver, name, true);
        String type = field == null ? null : KotlinFieldValues.elementType(field.signature());
        ArrayReference array = type == null ? null : KotlinFieldValues.array(field, receiver.object.getValue(field));
        if (array == null) throw invalid("Choose a present Kotlin primitive array field.");
        int start = KotlinFieldValues.index(args, "start"), count = KotlinFieldValues.index(args, "count");
        int length = array.length();
        if (start >= length || count < 1 || count > KotlinFieldValues.PAGE_SIZE) {
            throw invalid("Request at most 32 elements within this Kotlin array.");
        }
        List<Value> values = array.getValues(start, Math.min(count, length - start));
        var observed = new Page(UUID.randomUUID().toString(), frame, receiver, field, array, start, values, System.nanoTime());
        var items = new ArrayList<Map<String,Object>>();
        for (int i = 0; i < values.size(); i++) items.add(Map.of("index", start + i, "value", scalarDisplay(values.get(i))));
        PAGES.put(context, observed);
        return Map.of("pageId", observed.id, "receiver", receiver.local.name(), "name", name,
            "elementType", type, "length", length, "start", start, "items", items);
    }

    private static Map<String,Object> prepareElement(IDebugAdapterContext context, JsonObject args, Frame frame,
                                                     Receiver receiver, String name, String input) {
        Page page = PAGES.get(context);
        if (page == null || !page.id.equals(KotlinLocalAssignment.text(args, "pageId"))) throw stalePage();
        checkFrame(page.frame, page.prepared, frame);
        Field field = field(receiver, name, true);
        int index = KotlinFieldValues.index(args, "index");
        if (!sameReceiver(page.receiver, receiver) || !page.field.equals(field) || index < page.start ||
            index - page.start >= page.values.size()) throw stalePage();
        var array = KotlinFieldValues.array(field, receiver.object.getValue(field));
        if (!page.array.equals(array)) throw invalid("The Kotlin array instance changed. Open its current elements again.");
        if (!canEditElements(receiver, field)) throw invalid("Choose an editable Kotlin array element with direct storage.");
        Value original = array.getValue(index);
        if (!Objects.equals(original, page.values.get(index - page.start))) throw invalid("The Kotlin array element changed. Open its current values again.");
        if (input == null || input.length() > MAX_LOCALS) throw invalid("Choose a matching Kotlin array element literal.");
        String type = KotlinFieldValues.elementType(field.signature());
        Value replacement = KotlinLocalAssignment.mirror(frame.frame.virtualMachine(), KotlinLocalAssignment.scalar(type, input));
        return review(context, frame, receiver, field, original, new Replacement(replacement, null), array, index, type,
            scalarDisplay(original), scalarDisplay(replacement));
    }

    private static Map<String,Object> review(IDebugAdapterContext context, Frame frame, Receiver receiver, Field field,
                                              Value original, Replacement replacement, ArrayReference array, int index,
                                              String type, String before, String after) {
        var review = new Review(UUID.randomUUID().toString(), frame, receiver, field, original, replacement, array, index, System.nanoTime());
        var summary = new LinkedHashMap<String,Object>();
        summary.putAll(Map.of("reviewId", review.id, "receiver", receiver.local.name(), "owner", receiver.owner.name(),
            "name", field.name(), "type", type, "before", before, "after", after));
        if (array != null) summary.put("index", index);
        if (replacement.boxing != null) summary.put("boxLiteral", true);
        REVIEWS.put(context, review);
        return summary;
    }

    private static Map<String,Object> apply(IDebugAdapterContext context, JsonObject args, Review review) throws Exception {
        Frame selected = selectedFrame(context, args);
        checkFrame(review.frame, review.prepared, selected);
        if (review.replacement.boxing != null) return applyBox(context, args, review, selected);
        boolean needsLocal = review.array != null || review.replacement.text != null;
        if (needsLocal && !extended(context, selected)) throw stale();
        var vm = selected.frame.virtualMachine();
        if (!vm.canBeModified()) throw invalid("This Kotlin JVM does not allow field updates.");
        // A method breakpoint can suspend only one thread. Freeze other threads only for compare-and-write,
        // and balance precisely this suspension without changing the debugger's existing thread state.
        vm.suspend();
        try {
            Frame current = selectedFrame(context, args);
            checkFrame(review.frame, review.prepared, current);
            if (current.reference.getThread().suspendCount() < 2) throw stale();
            Receiver receiver = receiver(current.frame, visible(current.frame, review.receiver.local.name()));
            if (!sameReceiver(review.receiver, receiver)) throw stale();
            Field field = field(receiver, review.field.name(), needsLocal);
            if (review.array != null) {
                if (!review.field.equals(field) || !canEditElements(receiver, field)) throw stale();
                var array = KotlinFieldValues.array(field, receiver.object.getValue(field));
                if (!review.array.equals(array)) throw invalid("The Kotlin array instance changed. Open its current elements again.");
                if (!Objects.equals(review.original, array.getValue(review.index))) {
                    throw invalid("The Kotlin array element changed. Open its current values again.");
                }
                array.setValue(review.index, review.replacement.value);
                return Map.of("state", "applied", "receiver", receiver.local.name(), "name", field.name(),
                    "index", review.index, "value", scalarDisplay(array.getValue(review.index)));
            }
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
            StringReference text = review.replacement.text == null ? null : vm.mirrorOf(review.replacement.text);
            if (text != null) text.disableCollection();
            try {
                if (text != null && !KotlinFieldValues.quote(review.replacement.text).equals(KotlinFieldValues.displayText(text))) {
                    throw invalid("JDI could not represent the exact reviewed Kotlin String. Review another value.");
                }
                receiver.object.setValue(field, text == null ? review.replacement.value : text);
                Value updated = receiver.object.getValue(field);
                return Map.of("state", "applied", "receiver", receiver.local.name(), "name", field.name(),
                    "value", text == null ? display(field, updated) : KotlinFieldValues.displayText(updated));
            } finally {
                if (text != null) text.enableCollection();
            }
        } finally {
            vm.resume();
        }
    }

    private static Map<String,Object> applyBox(IDebugAdapterContext context, JsonObject args, Review review, Frame selected) throws Exception {
        if (!REVIEWED_LOCAL_ATTACH.containsKey(context)) throw boxUnavailable();
        var thread = selected.reference.getThread();
        var vm = selected.frame.virtualMachine();
        var location = selected.frame.location();
        checkedBoxReceiver(selected, review);
        var boxing = KotlinFieldValues.boxing(review.field, thread, selected.reference.getDepth());
        if (!review.replacement.boxing.matches(boxing)) throw boxUnavailable();
        // JDWP only allows NewInstance on the event suspension. Keep every other thread's state
        // and reload the invalidated frame before acquiring the separate compare-and-write freeze.
        ObjectReference made;
        try { made = boxing.construct(thread, review.replacement.value); }
        finally {
            if (thread.isSuspended()) context.getStackFrameManager().reloadStackFrames(thread);
        }
        if (made == null) throw boxUnavailable();
        made.disableCollection();
        try {
            if (thread.suspendCount() != 1 || !boxing.owner.equals(made.referenceType()) ||
                    !review.replacement.value.equals(made.getValue(boxing.storage))) throw boxUnavailable();
            vm.suspend();
            try {
                Frame current = selectedFrame(context, args);
                if (current.id != selected.id || current.reference != selected.reference || thread.suspendCount() != 2 ||
                    !location.equals(current.frame.location()) || location.method().isObsolete() ||
                    System.nanoTime() - review.prepared > TimeUnit.SECONDS.toNanos(30)) throw stale();
                Receiver receiver = checkedBoxReceiver(current, review);
                receiver.object.setValue(review.field, made);
                if (!made.equals(receiver.object.getValue(review.field))) throw boxUnavailable();
                return Map.of("state", "applied", "receiver", receiver.local.name(), "name", review.field.name(),
                    "value", scalarDisplay(review.replacement.value), "boxLiteral", true);
            } finally { vm.resume(); }
        } finally { made.enableCollection(); }
    }

    private static Receiver checkedBoxReceiver(Frame frame, Review review) throws Exception {
        Receiver receiver = receiver(frame.frame, visible(frame.frame, review.receiver.local.name()));
        if (!sameReceiver(review.receiver, receiver)) throw stale();
        Field field = field(receiver, review.field.name(), false);
        if (!review.field.equals(field) || !writable(receiver, field) ||
            !Objects.equals(review.original, receiver.object.getValue(field))) {
            throw invalid("The Kotlin object field changed. Inspect its current value again.");
        }
        return receiver;
    }

    private static IllegalArgumentException boxUnavailable() {
        return invalid("Create boxed literals only on the top breakpoint frame of a verified local JVM with supported wrappers and no intercepting debugger events.");
    }

    private static boolean sameReceiver(Receiver before, Receiver current) {
        return current != null && before.local.equals(current.local) && before.object.equals(current.object)
            && before.owner.equals(current.owner);
    }

    private static void checkFrame(Frame before, long prepared, Frame target) {
        if (before.id != target.id || before.reference != target.reference || !before.frame.equals(target.frame) ||
            before.frame.location().method().isObsolete() || System.nanoTime() - prepared > TimeUnit.SECONDS.toNanos(30)) throw stale();
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

    private static List<Field> supportedFields(Receiver receiver, boolean extended) {
        List<Field> all = receiver.owner.fields();
        if (all.size() > MAX_CLASS_FIELDS) throw invalid("This Kotlin class has more than 256 declared JVM fields.");
        var names = new java.util.HashSet<String>();
        var duplicates = new java.util.HashSet<String>();
        for (Field field : all) if (!names.add(field.name())) duplicates.add(field.name());
        return all.stream().filter(field -> !duplicates.contains(field.name()) && inspectable(field, extended))
            .collect(java.util.stream.Collectors.toList());
    }

    private static boolean inspectable(Field field, boolean extended) {
        return !field.isStatic() && !field.isSynthetic() && KotlinLocalAssignment.isName(field.name()) &&
            (type(field) != null || extended && (KotlinFieldValues.isString(field) || KotlinFieldValues.elementType(field.signature()) != null));
    }

    private static Field field(Receiver receiver, String name, boolean extended) {
        return supportedFields(receiver, extended).stream().filter(field -> field.name().equals(name)).findFirst().orElse(null);
    }

    private static boolean writable(Receiver receiver, Field field) {
        return field != null && receiver.object.virtualMachine().canBeModified() && KotlinFieldAccess.writable(field,
            field.isFinal() || field.isPublic() ? null : KotlinFieldAccess.inspect(receiver.owner));
    }

    private static boolean canEditElements(Receiver receiver, Field field) {
        return canEditElements(receiver, field, field.isPublic() ? null : KotlinFieldAccess.inspect(receiver.owner));
    }

    private static boolean canEditElements(Receiver receiver, Field field, KotlinFieldAccess access) {
        return receiver.object.virtualMachine().canBeModified() && KotlinFieldAccess.directGetter(field, access);
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
        return scalarDisplay(value);
    }

    private static String scalarDisplay(Value value) {
        if (!(value instanceof PrimitiveValue)) throw invalid("The Kotlin field scalar layout is unavailable.");
        return value.toString();
    }

    private static IllegalArgumentException invalid(String message) { return new IllegalArgumentException(message); }
    private static IllegalArgumentException stale() { return invalid("Keep the same Kotlin frame suspended and review the object field again."); }
    private static IllegalArgumentException stalePage() { return invalid("Open the current Kotlin array page before reviewing its element."); }

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
        final String text;
        final KotlinFieldValues.Boxing boxing;
        Replacement(Value value, LocalVariable source) { this(value,source,null); }
        Replacement(Value value, LocalVariable source, String text) { this(value,source,text,null); }
        Replacement(Value value, LocalVariable source, String text, KotlinFieldValues.Boxing boxing) {
            this.value=value; this.source=source; this.text=text; this.boxing=boxing;
        }
    }

    private static final class Page {
        final String id;
        final Frame frame;
        final Receiver receiver;
        final Field field;
        final ArrayReference array;
        final int start;
        final List<Value> values;
        final long prepared;
        Page(String id, Frame frame, Receiver receiver, Field field, ArrayReference array, int start, List<Value> values, long prepared) {
            this.id=id; this.frame=frame; this.receiver=receiver; this.field=field; this.array=array;
            this.start=start; this.values=values; this.prepared=prepared;
        }
    }

    private static final class Review {
        final String id;
        final Frame frame;
        final Receiver receiver;
        final Field field;
        final Value original;
        final Replacement replacement;
        final ArrayReference array;
        final int index;
        final long prepared;
        Review(String id, Frame frame, Receiver receiver, Field field, Value original, Replacement replacement,
               ArrayReference array, int index, long prepared) {
            this.id=id; this.frame=frame; this.receiver=receiver; this.field=field;
            this.original=original; this.replacement=replacement; this.array=array; this.index=index; this.prepared=prepared;
        }
    }
}
