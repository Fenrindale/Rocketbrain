import com.sun.jdi.Bootstrap;
import com.sun.jdi.LocalVariable;
import com.sun.jdi.Location;
import com.sun.jdi.PrimitiveValue;
import com.sun.jdi.ReferenceType;
import com.sun.jdi.StackFrame;
import com.sun.jdi.VMDisconnectedException;
import com.sun.jdi.VirtualMachine;
import com.sun.jdi.connect.AttachingConnector;
import com.sun.jdi.event.BreakpointEvent;
import com.sun.jdi.event.ClassPrepareEvent;
import com.sun.jdi.event.Event;
import com.sun.jdi.event.EventSet;
import com.sun.jdi.event.VMDeathEvent;
import com.sun.jdi.event.VMDisconnectEvent;
import com.sun.jdi.request.BreakpointRequest;
import com.sun.jdi.request.ClassPrepareRequest;
import com.sun.jdi.request.EventRequest;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/** A one-stop, read-only source and primitive locals observer for an owned Android ART app. */
final class AndroidBreakpoint {
    public static void main(String[] arguments) {
        try {
            if (arguments.length != 4 || !arguments[0].matches("[1-9][0-9]{0,4}") ||
                    Integer.parseInt(arguments[0]) > 65535 || !arguments[1].matches("[A-Za-z][A-Za-z0-9_.]{2,220}") ||
                    !arguments[2].matches("[A-Za-z][A-Za-z0-9_]{0,95}\\.kt") || !arguments[3].matches("[1-9][0-9]{0,6}")) {
                throw new IllegalArgumentException("Invalid reviewed Kotlin Android source location.");
            }
            observe(arguments[0], arguments[1], arguments[2], Integer.parseInt(arguments[3]));
        } catch (Exception failure) {
            String reason = failure instanceof IllegalArgumentException ? failure.getMessage() : "The Android JDWP source session could not be read.";
            System.out.println("ERROR " + reason);
            System.exit(1);
        }
    }

    private static void observe(String port, String className, String file, int line) throws Exception {
        AttachingConnector connector = Bootstrap.virtualMachineManager().attachingConnectors().stream()
            .filter(candidate -> candidate.name().equals("com.sun.jdi.SocketAttach")).findFirst().orElseThrow();
        var arguments = connector.defaultArguments();
        arguments.get("hostname").setValue("127.0.0.1");
        arguments.get("port").setValue(port);
        arguments.get("timeout").setValue("8000");
        VirtualMachine vm = connector.attach(arguments);
        try {
            String runtime = vm.name() + " " + vm.description();
            if (!runtime.toLowerCase(java.util.Locale.ROOT).matches("(?s).*\\b(dalvik|art|android)\\b.*")) {
                throw new IllegalArgumentException("The scoped JDWP target is not Android ART.");
            }
            ClassPrepareRequest prepare = vm.eventRequestManager().createClassPrepareRequest();
            prepare.addClassFilter(className);
            prepare.setSuspendPolicy(EventRequest.SUSPEND_EVENT_THREAD);
            prepare.enable();
            List<ReferenceType> classes = vm.classesByName(className).stream().filter(ReferenceType::isPrepared).toList();
            if (classes.size() > 1) throw new IllegalArgumentException("Multiple Android classes use the selected Kotlin identity.");
            BreakpointRequest breakpoint = classes.isEmpty() ? null : breakpoint(vm, classes.get(0), file, line);
            announce(breakpoint == null ? "WAITING" : "READY");
            long deadline = System.nanoTime() + 120_000_000_000L;
            while (System.nanoTime() < deadline) {
                EventSet events = vm.eventQueue().remove(1000);
                if (events == null) continue;
                try {
                    for (Event event : events) {
                        if (event instanceof VMDeathEvent || event instanceof VMDisconnectEvent) {
                            throw new IllegalArgumentException("The owned Android process exited before the breakpoint.");
                        }
                        if (event instanceof ClassPrepareEvent loaded) {
                            if (breakpoint != null && !breakpoint.location().declaringType().equals(loaded.referenceType())) {
                                throw new IllegalArgumentException("The Kotlin class was loaded under a second Android class loader.");
                            }
                            if (breakpoint == null) {
                                breakpoint = breakpoint(vm, loaded.referenceType(), file, line);
                                announce("READY");
                            }
                        }
                        if (event instanceof BreakpointEvent hit && breakpoint != null && breakpoint.equals(event.request())) {
                            breakpoint.disable();
                            StackFrame frame = hit.thread().frame(0);
                            if (frame.location().lineNumber() != line || !file.equals(frame.location().sourceName()) ||
                                !className.equals(frame.location().declaringType().name())) {
                                throw new IllegalArgumentException("The suspended Android source location changed.");
                            }
                            announce("STOP " + locals(frame));
                            try {
                                String command = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8)).readLine();
                                if (!"continue".equals(command)) return;
                            } finally { events.resume(); }
                            announce("CONTINUED");
                            return;
                        }
                    }
                } finally {
                    if (breakpoint == null || breakpoint.isEnabled()) events.resume();
                }
            }
            throw new IllegalArgumentException("The selected Android source breakpoint did not stop within two minutes.");
        } finally {
            try { vm.dispose(); } catch (VMDisconnectedException closed) { /* target already released */ }
        }
    }

    private static BreakpointRequest breakpoint(VirtualMachine vm, ReferenceType type, String file, int line) throws Exception {
        List<Location> locations = new ArrayList<>();
        for (Location location : type.locationsOfLine(line)) {
            if (file.equals(location.sourceName()) && !locations.contains(location)) locations.add(location);
        }
        if (locations.size() != 1) throw new IllegalArgumentException("Choose one exact executable Kotlin line from this debuggable APK.");
        BreakpointRequest request = vm.eventRequestManager().createBreakpointRequest(locations.get(0));
        request.setSuspendPolicy(EventRequest.SUSPEND_EVENT_THREAD);
        request.enable();
        return request;
    }

    private static String locals(StackFrame frame) throws Exception {
        List<String> rows = new ArrayList<>();
        for (LocalVariable local : frame.visibleVariables()) {
            if (rows.size() == 32) break;
            if (!local.name().matches("[A-Za-z_][A-Za-z0-9_]{0,95}") ||
                !local.signature().matches("[ZBCSIJFD]")) continue;
            if (frame.getValue(local) instanceof PrimitiveValue primitive) {
                String value = local.signature().equals("C") ? Integer.toString(primitive.charValue()) : primitive.toString();
                if (!value.matches("[0-9A-Za-z.+-]{1,80}")) continue;
                rows.add("{\"name\":\"" + local.name() + "\",\"type\":\"" + primitive.type().name() + "\",\"value\":\"" + value + "\"}");
            }
        }
        if (rows.isEmpty()) throw new IllegalArgumentException("No named primitive local is visible at this Kotlin source line.");
        return "[" + String.join(",", rows) + "]";
    }

    private static void announce(String text) {
        System.out.println(text);
        System.out.flush();
    }
}
