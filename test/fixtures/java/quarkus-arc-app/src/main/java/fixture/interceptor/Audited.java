package fixture.interceptor;

import java.lang.annotation.Retention;
import java.lang.annotation.Target;
import jakarta.enterprise.util.Nonbinding;
import jakarta.interceptor.InterceptorBinding;
import static java.lang.annotation.ElementType.METHOD;
import static java.lang.annotation.ElementType.TYPE;
import static java.lang.annotation.RetentionPolicy.RUNTIME;

@InterceptorBinding @Retention(RUNTIME) @Target({TYPE, METHOD})
public @interface Audited {
    String value();
    @Nonbinding String note() default "";
}
