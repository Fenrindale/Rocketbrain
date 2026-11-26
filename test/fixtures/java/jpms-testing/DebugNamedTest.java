import com.sun.jdi.Bootstrap;
import com.sun.jdi.VirtualMachine;
import com.sun.jdi.event.BreakpointEvent;
import com.sun.jdi.event.ClassPrepareEvent;
import com.sun.jdi.event.VMDeathEvent;
import com.sun.jdi.event.VMDisconnectEvent;
import com.sun.jdi.request.EventRequest;

public class DebugNamedTest {
    public static void main(String[] args) throws Exception {
        var connector = Bootstrap.virtualMachineManager().attachingConnectors().stream()
            .filter(candidate -> candidate.name().equals("com.sun.jdi.SocketAttach"))
            .findFirst().orElseThrow();
        var parameters = connector.defaultArguments();
        parameters.get("hostname").setValue("127.0.0.1");
        parameters.get("port").setValue(args[0]);
        parameters.get("timeout").setValue("5000");
        VirtualMachine machine = connector.attach(parameters);
        try {
            var manager = machine.eventRequestManager();
            var prepare = manager.createClassPrepareRequest();
            prepare.addClassFilter("fixture.jpms.tests.InvoiceModuleTest");
            prepare.setSuspendPolicy(EventRequest.SUSPEND_EVENT_THREAD);
            prepare.enable();
            machine.resume();
            long deadline = System.nanoTime() + 15_000_000_000L;
            while (System.nanoTime() < deadline) {
                var set = machine.eventQueue().remove(1000);
                if (set == null) continue;
                boolean observed = false;
                for (var event : set) {
                    if (event instanceof ClassPrepareEvent prepared) {
                        var method = prepared.referenceType().methodsByName("executesSpringJdbc").getFirst();
                        var breakpoint = manager.createBreakpointRequest(method.location());
                        breakpoint.setSuspendPolicy(EventRequest.SUSPEND_EVENT_THREAD);
                        breakpoint.enable();
                        prepare.disable();
                    } else if (event instanceof BreakpointEvent hit) {
                        var location = hit.location();
                        String module = location.declaringType().module().name();
                        if (!"fixture.jpms.tests".equals(module) || location.lineNumber() <= 0 ||
                            !location.method().name().equals("executesSpringJdbc")) {
                            throw new IllegalStateException("The stopped frame is outside the selected named test.");
                        }
                        System.out.println(module + "/" + location.method().name() + ":" + location.lineNumber());
                        observed = true;
                    } else if (event instanceof VMDeathEvent || event instanceof VMDisconnectEvent) {
                        throw new IllegalStateException("The owned test finished before its breakpoint.");
                    }
                }
                set.resume();
                if (observed) return;
            }
            throw new IllegalStateException("The named test breakpoint was not observed.");
        } finally {
            try {
                machine.dispose();
            } catch (com.sun.jdi.VMDisconnectedException alreadyExited) {
                // The owned test can finish immediately after resuming its breakpoint.
            }
        }
    }
}
