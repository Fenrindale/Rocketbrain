package fixture.interceptor;

import jakarta.annotation.Priority;
import jakarta.interceptor.AroundInvoke;
import jakarta.interceptor.Interceptor;
import jakarta.interceptor.InvocationContext;

@Interceptor @Priority(50) @Audited("halt") @Detailed
public class AuditStop {
    @AroundInvoke Object around(InvocationContext invocation) {
        return "stopped";
    }
}
