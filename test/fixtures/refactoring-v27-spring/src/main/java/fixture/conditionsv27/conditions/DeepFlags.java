package fixture.conditionsv27.conditions;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;
import org.springframework.core.annotation.AliasFor;

@Retention(RetentionPolicy.RUNTIME)
@Target({ElementType.TYPE, ElementType.METHOD})
@LocalFlags(flags = "disabled")
public @interface DeepFlags {
    @AliasFor(annotation = LocalFlags.class, attribute = "flags")
    String[] routes() default {"enabled"};
}
