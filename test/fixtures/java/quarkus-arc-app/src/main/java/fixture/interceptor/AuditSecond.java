package fixture.interceptor;

import jakarta.annotation.Priority;
import jakarta.interceptor.AroundInvoke;
import jakarta.interceptor.Interceptor;
import jakarta.interceptor.InvocationContext;

@Interceptor @Priority(200) @Audited("standard") @Detailed
public class AuditSecond {
    @AroundInvoke Object around(InvocationContext invocation) throws Exception {
        return "second(" + invocation.proceed() + ")";
    }
}
