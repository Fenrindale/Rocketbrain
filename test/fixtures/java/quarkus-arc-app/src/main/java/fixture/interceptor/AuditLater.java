package fixture.interceptor;

import jakarta.annotation.Priority;
import jakarta.interceptor.AroundInvoke;
import jakarta.interceptor.Interceptor;
import jakarta.interceptor.InvocationContext;

@Interceptor @Priority(250) @Audited("halt") @Detailed
public class AuditLater {
    @AroundInvoke Object around(InvocationContext invocation) {
        throw new AssertionError("The preceding interceptor must short-circuit");
    }
}
