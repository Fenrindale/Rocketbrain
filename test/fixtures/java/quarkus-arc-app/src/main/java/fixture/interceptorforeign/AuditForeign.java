package fixture.interceptorforeign;

import fixture.interceptor.Audited;
import jakarta.annotation.Priority;
import jakarta.interceptor.AroundInvoke;
import jakarta.interceptor.Interceptor;
import jakarta.interceptor.InvocationContext;

@Interceptor @Priority(400) @Audited("external")
public class AuditForeign {
    @AroundInvoke Object around(InvocationContext invocation) throws Exception {
        return "foreign(" + invocation.proceed() + ")";
    }
}
