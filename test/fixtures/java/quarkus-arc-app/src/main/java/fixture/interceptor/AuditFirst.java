package fixture.interceptor;

import jakarta.annotation.Priority;
import jakarta.interceptor.AroundInvoke;
import jakarta.interceptor.Interceptor;
import jakarta.interceptor.InvocationContext;

@Interceptor @Priority(100) @Audited(value = "standard", note = "fixture-private-interceptor")
public class AuditFirst {
    @AroundInvoke Object around(InvocationContext invocation) throws Exception {
        return "first(" + invocation.proceed() + ")";
    }
}
