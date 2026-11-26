package com.microsoft.java.debug.core.adapter;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.microsoft.java.debug.core.protocol.Events;
import com.microsoft.java.debug.core.protocol.Messages;
import com.sun.jdi.ArrayReference;
import com.sun.jdi.IntegerValue;
import com.sun.jdi.LongValue;
import com.sun.jdi.Method;
import com.sun.jdi.ObjectReference;
import com.sun.jdi.ReferenceType;
import com.sun.jdi.StringReference;
import com.sun.jdi.Value;
import com.sun.jdi.VirtualMachine;
import com.sun.jdi.event.MethodEntryEvent;
import com.sun.jdi.request.EventRequest;
import com.sun.jdi.request.MethodEntryRequest;
import io.reactivex.disposables.Disposable;

import java.util.Map;
import java.util.WeakHashMap;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

/** Watches one observed Kotlin continuation using a real JDI instance filter. */
final class CoroutineFrameWatch {
    private static final String AGENT = "rocketbrain.coroutines.CoroutineProbeAgent";
    private static final String WATCH = "rocketbrainCoroutineFrame";
    private static final String EXPIRED = "rocketbrainCoroutineWatchExpired";
    private static final int WAIT_SECONDS = 45;
    private static final Map<IDebugAdapterContext, Watch> watches = new WeakHashMap<>();

    private CoroutineFrameWatch() { }

    static CompletableFuture<Messages.Response> dispatch(Messages.Request request, Messages.Response response, IDebugAdapterContext context) {
        try {
            if (!context.isAttached() || context.isVmTerminated() || request.arguments == null || context.getDebugSession() == null) {
                return error(response, "Attach to the opted-in Kotlin JVM first.");
            }
            JsonObject args = request.arguments;
            VirtualMachine vm = context.getDebugSession().getVM();
            var probes = vm.classesByName(AGENT);
            if (probes.size() != 1 || !(staticField(probes.get(0), "debugPid") instanceof LongValue) ||
                    !Long.toString(((LongValue) staticField(probes.get(0), "debugPid")).value()).equals(text(args, "pid")) ||
                    !matches(staticField(probes.get(0), "debugSession"), text(args, "session"))) {
                return error(response, "The attached JVM PID or coroutine probe session does not match.");
            }
            String action = text(args, "action");
            if ("verify".equals(action)) {
                response.body = Map.of("verified", true);
                return CompletableFuture.completedFuture(response);
            }
            if (!"watch".equals(action)) return error(response, "Choose an observed parked continuation.");
            arm(context, vm, probes.get(0), args, response);
            return CompletableFuture.completedFuture(response);
        } catch (IllegalArgumentException invalid) {
            return error(response, invalid.getMessage());
        } catch (Exception unavailable) {
            return error(response, "The reviewed Kotlin continuation or debug session is no longer available.");
        }
    }

    private static void arm(IDebugAdapterContext context, VirtualMachine vm, ReferenceType probe, JsonObject args,
                            Messages.Response response) throws Exception {
        String id = text(args, "watch");
        String capture = text(args, "capture");
        String sequence = text(args, "sequence");
        int ordinal = integer(args, "ordinal");
        int parkedLine = integer(args, "line");
        if (!vm.canUseInstanceFilters() || !uuid(id) || !uuid(capture) || ordinal < 0 || ordinal >= 100 || parkedLine <= 0) {
            throw new IllegalArgumentException("The JVM or selected Kotlin debug capture cannot support an instance breakpoint.");
        }
        Value current = staticField(probe, "debugCapture");
        if (!(current instanceof ObjectReference) || !matches(field(current, "id"), capture) ||
                !(field(current, "frames") instanceof ArrayReference) || ordinal >= ((ArrayReference) field(current, "frames")).length()) {
            throw new IllegalArgumentException("The Kotlin debug capture changed. Refresh and select the coroutine again.");
        }
        Value target = ((ArrayReference) field(current, "frames")).getValue(ordinal);
        Value continuationCandidate = field(field(target, "continuation"), "referent");
        if (!(continuationCandidate instanceof ObjectReference) || !matches(field(target, "sequence"), sequence) ||
                !matches(field(target, "className"), text(args, "className")) ||
                !matches(field(target, "file"), text(args, "file")) ||
                !(field(target, "line") instanceof IntegerValue) || ((IntegerValue) field(target, "line")).value() != parkedLine ||
                !(field(target, "label") instanceof IntegerValue) || !field(target, "label").equals(field(continuationCandidate, "label"))) {
            throw new IllegalArgumentException("The selected parked Kotlin continuation has resumed, disappeared or changed.");
        }
        ObjectReference continuation = (ObjectReference) continuationCandidate;
        ReferenceType owner = continuation.referenceType();
        var methods = owner.methodsByName("invokeSuspend", "(Ljava/lang/Object;)Ljava/lang/Object;");
        if (!owner.name().equals(text(args, "className")) || methods.size() != 1 || methods.get(0).isStatic() ||
                methods.get(0).location().lineNumber() <= 0 || !methods.get(0).location().sourceName().equals(text(args, "file"))) {
            throw new IllegalArgumentException("The continuation has no matching Kotlin source location in the attached JVM.");
        }
        MethodEntryRequest entry = vm.eventRequestManager().createMethodEntryRequest();
        Watch watch = new Watch(context, entry, id, sequence, parkedLine, continuation, methods.get(0));
        synchronized (watches) {
            if (watches.containsKey(context)) {
                vm.eventRequestManager().deleteEventRequest(entry);
                throw new IllegalArgumentException("Finish the pending Kotlin coroutine watch before selecting another.");
            }
            watches.put(context, watch);
        }
        try {
            entry.addClassFilter(owner);
            entry.addInstanceFilter(continuation);
            entry.setSuspendPolicy(EventRequest.SUSPEND_EVENT_THREAD);
            watch.observe();
            if (!current.equals(staticField(probe, "debugCapture")) || !field(target, "label").equals(field(continuation, "label"))) {
                throw new IllegalArgumentException("The Kotlin capture changed while its instance breakpoint was being armed.");
            }
            entry.enable();
            CompletableFuture.delayedExecutor(WAIT_SECONDS, TimeUnit.SECONDS).execute(watch::expire);
            response.body = Map.of("armed", true, "watch", id, "expiresInSeconds", WAIT_SECONDS);
        } catch (Exception failure) {
            watch.close();
            throw failure;
        }
    }

    private static final class Watch {
        private final IDebugAdapterContext context;
        private final MethodEntryRequest request;
        private final String id;
        private final String sequence;
        private final int parkedLine;
        private final ObjectReference continuation;
        private final Method resume;
        private Disposable subscription;
        private boolean closed;

        Watch(IDebugAdapterContext context, MethodEntryRequest request, String id, String sequence,
              int parkedLine, ObjectReference continuation, Method resume) {
            this.context = context;
            this.request = request;
            this.id = id;
            this.sequence = sequence;
            this.parkedLine = parkedLine;
            this.continuation = continuation;
            this.resume = resume;
        }

        synchronized void observe() {
            subscription = context.getDebugSession().getEventHub().events()
                    .filter(event -> event.event instanceof MethodEntryEvent && request.equals(event.event.request()))
                    .subscribe(event -> {
                        var entered = (MethodEntryEvent) event.event;
                        if (!entered.method().equals(resume)) return;
                        var thread = entered.thread();
                        if (!continuation.equals(thread.frame(0).thisObject())) return;
                        var location = entered.location();
                        if (!close()) return;
                        var found = new FrameEvent(id, sequence, thread.uniqueID(), location.declaringType().name(),
                                location.sourceName(), location.lineNumber(), parkedLine);
                        context.getThreadCache().addEventThread(thread, "breakpoint");
                        context.getProtocolServer().sendEvent(found);
                        context.getProtocolServer().sendEvent(new Events.StoppedEvent("breakpoint", found.threadId, false,
                                "Kotlin coroutine resumed", "Selected Kotlin continuation"));
                        event.shouldResume = false;
                    }, failure -> close(), this::close);
        }

        void expire() {
            if (close() && !context.isVmTerminated()) context.getProtocolServer().sendEvent(new WatchExpired(id));
        }

        synchronized boolean close() {
            if (closed) return false;
            closed = true;
            synchronized (watches) { watches.remove(context, this); }
            if (subscription != null) subscription.dispose();
            try { request.virtualMachine().eventRequestManager().deleteEventRequest(request); }
            catch (RuntimeException ended) { /* JDWP clears temporary requests on detach. */ }
            return true;
        }
    }

    static final class FrameEvent extends Events.DebugEvent {
        public final String watch, sequence, className, file;
        public final long threadId;
        public final int line, parkedLine;
        FrameEvent(String watch, String sequence, long threadId, String className, String file, int line, int parkedLine) {
            super(WATCH);
            this.watch = watch;
            this.sequence = sequence;
            this.threadId = threadId;
            this.className = className;
            this.file = file;
            this.line = line;
            this.parkedLine = parkedLine;
        }
    }

    static final class WatchExpired extends Events.DebugEvent {
        public final String watch;
        WatchExpired(String watch) { super(EXPIRED); this.watch = watch; }
    }

    private static Value staticField(ReferenceType source, String name) {
        var field = source.fieldByName(name);
        return field != null && field.isStatic() ? source.getValue(field) : null;
    }

    private static Value field(Value source, String name) {
        if (!(source instanceof ObjectReference)) return null;
        var object = (ObjectReference) source;
        var field = object.referenceType().fieldByName(name);
        return field != null && !field.isStatic() ? object.getValue(field) : null;
    }

    private static boolean matches(Value value, String wanted) {
        return wanted != null && value instanceof StringReference && wanted.equals(((StringReference) value).value());
    }

    private static boolean uuid(String value) {
        return value != null && value.matches("[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}");
    }

    private static String text(JsonObject args, String key) {
        JsonElement value = args.get(key);
        if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isString()) return null;
        String text = value.getAsString();
        return text.length() <= 200 ? text : null;
    }

    private static int integer(JsonObject args, String key) {
        JsonElement value = args.get(key);
        if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isNumber() ||
                !value.getAsString().matches("[0-9]{1,8}")) return -1;
        return value.getAsInt();
    }

    private static CompletableFuture<Messages.Response> error(Messages.Response response, String message) {
        return AdapterUtils.createAsyncErrorResponse(response, ErrorCode.GET_VARIABLE_FAILURE, message);
    }
}
