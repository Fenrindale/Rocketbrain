import com.sun.jdi.Bootstrap;
import com.sun.jdi.ReferenceType;
import com.sun.jdi.StringReference;
import com.sun.jdi.VirtualMachine;
import com.sun.jdi.connect.AttachingConnector;
import com.sun.jdi.event.BreakpointEvent;
import com.sun.jdi.event.Event;
import com.sun.jdi.event.EventSet;
import com.sun.jdi.request.BreakpointRequest;
import com.sun.jdi.request.EventRequest;

public class JdiAttachFixture {
  public static void main(String[] args) throws Exception {
    int line = Integer.parseInt(args[1]);
    AttachingConnector socket = Bootstrap.virtualMachineManager().attachingConnectors().stream()
        .filter(connector -> connector.name().equals("com.sun.jdi.SocketAttach"))
        .findFirst().orElseThrow();
    var parameters = socket.defaultArguments();
    parameters.get("hostname").setValue("127.0.0.1");
    parameters.get("port").setValue(args[0]);
    parameters.get("timeout").setValue("5000");
    VirtualMachine vm = socket.attach(parameters);
    try {
      ReferenceType type = vm.classesByName("PortFixture").getFirst();
      var location = type.locationsOfLine(line).stream()
          .filter(candidate -> candidate.method().name().equals("responseBody"))
          .findFirst().orElseThrow();
      BreakpointRequest request = vm.eventRequestManager().createBreakpointRequest(location);
      request.setSuspendPolicy(EventRequest.SUSPEND_EVENT_THREAD);
      request.enable();
      System.out.println("JDI_READY");
      System.out.flush();
      for (int attempt = 0; attempt < 6; attempt++) {
        EventSet events = vm.eventQueue().remove(2500);
        if (events == null) continue;
        try {
          for (Event event : events) {
            if (event instanceof BreakpointEvent breakpoint && event.request() == request) {
              if (breakpoint.location().lineNumber() != line || !breakpoint.location().sourceName().equals("PortFixture.java")) {
                throw new IllegalStateException("Unexpected source breakpoint");
              }
              var frame = breakpoint.thread().frame(0);
              var variable = frame.visibleVariableByName("body");
              if (!(frame.getValue(variable) instanceof StringReference body) ||
                  !body.value().equals("rocketbrain-container-http\n")) {
                throw new IllegalStateException("Unexpected local Java value");
              }
              request.disable();
              System.out.println("JDI_BREAKPOINT_AND_VALUE");
              return;
            }
          }
        } finally {
          events.resume();
        }
      }
      throw new IllegalStateException("The source breakpoint did not stop");
    } finally {
      vm.dispose();
    }
  }
}
