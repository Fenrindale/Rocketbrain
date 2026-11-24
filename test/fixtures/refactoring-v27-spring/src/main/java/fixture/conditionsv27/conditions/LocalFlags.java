package fixture.conditionsv27.conditions;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;
import org.springframework.boot.autoconfigure.condition.ConditionalOnBooleanProperty;
import org.springframework.core.annotation.AliasFor;

@Retention(RetentionPolicy.RUNTIME)
@Target({ElementType.TYPE, ElementType.METHOD})
@ConditionalOnBooleanProperty(prefix = "rocketbrain.fixture.flags", name = "disabled")
public @interface LocalFlags {
    @AliasFor(annotation = ConditionalOnBooleanProperty.class, attribute = "name")
    String[] flags() default {"missing"};
}
